/*jslint bitwise: true, node: true */
'use strict';

var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var SAT = require('sat');

// Import game settings.
var c = require('../../config.json');

// Redis Cloud stuff
var redis = require('redis');
var client = redis.createClient(c.redisUrl, {no_ready_check: true});

// Import utilities.
var util = require('./lib/util');

var args = {x : 0, y : 0, h : c.gameHeight, w : c.gameWidth, maxChildren : 1, maxDepth : 5};
console.log(args);

var users = [];
var food = [];
var sockets = {};
var gameCharge = 0;

var MAX_LEADER_BOARD_SIZE = 10;

var leaderboard = [];
loadLeaderBoardFromRedis();
var leaderboardChanged = true;
var lastLeaderboardString = "";

var V = SAT.Vector;
var C = SAT.Circle;

var initMassLog = util.log(c.defaultPlayerMass, c.slowBase);

app.use(express.static(__dirname + '/../client'));

function calculateVector(p1, p2, min, max) {
    var standardVector = p2 - p1;

    var tunneledVectorCandidate1 = (p2 - max) - (p1 - min);
    var tunneledVectorCandidate2 = (p2 - min) - (p1 - max);

    var tunneledVector;
    if (Math.abs(tunneledVectorCandidate1) <= Math.abs(tunneledVectorCandidate2)) {
        tunneledVector = tunneledVectorCandidate1;
    }
    else {
        tunneledVector = tunneledVectorCandidate2;
    }

    if (Math.abs(standardVector) <= Math.abs(tunneledVector)) {
        return standardVector;
    }
    else {
        return tunneledVector;
    }
}

function moveFood(food) {
    var totalDeltaX = 0;
    var totalDeltaY = 0;
    var desX = food.x;
    var desY = food.y;

    // for each player
    for (var i = 0; i < users.length; i++) {
        var player = users[i];

        var deltaX = 0;
        var deltaY = 0;

        // find the distance between the particle and the player
        var vectorX = calculateVector(food.x, player.x, 0, c.gameWidth);
        var vectorY = calculateVector(food.y, player.y, 0, c.gameHeight);

        var distance = vectorX*vectorX+vectorY*vectorY;

        if (distance > 1000000) continue;
        // calculate the force
        var force = player.chargeTotal * food.charge / distance / 5;

        // calculate the acceleration
        var accelX = force * vectorX;
        var accelY = force * vectorY;

        // calculate the delta
        deltaX = accelX * 20;
        deltaY = accelY * 20;
        totalDeltaX -= deltaX;
        totalDeltaY -= deltaY;

    }
    // cap the total delta
    if (Math.abs(totalDeltaX) > 6) {
        totalDeltaX = totalDeltaX > 0 ? 6 : -6;
    }
    if (Math.abs(totalDeltaY) > 6) {
        totalDeltaY = totalDeltaY > 0 ? 6 : -6;
    }
    // Move the combined delta to the food's position
    desX += totalDeltaX;
    desY += totalDeltaY;

    // Keep food inside the game board
    if (desX < 0) {
        desX = c.gameWidth;
    } else if (desX > c.gameWidth) {
        desX = 0;
    }
    if (desY < 0) {
        desY = c.gameHeight;
    } else if (desY > c.gameHeight) {
        desY = 0;
    }
    food.x = desX;
    food.y = desY;
}

function addFood(toAdd) {
    var radius = c.foodRadius;
    while (toAdd--) {
        var position = c.foodUniformDisposition ? util.uniformPosition(food, radius) : util.randomPosition(radius);
        var charge = gameCharge <= 0 ? 1 : -1;

        gameCharge += charge;

        food.push({
            // Make IDs unique.
            id: ((new Date()).getTime() + '' + food.length) >>> 0,
            x: position.x,
            y: position.y,
            radius: radius,
            mass: Math.random() + 2,
            charge: charge,
            hue: 118 - (charge * 80)
        });
    }
}

function removeFood(toRem) {
    while (toRem--) {
        food.pop();
    }
}

function movePlayer(player) {
    var x =0,y =0;
    for(var i=0; i<player.cells.length; i++)
    {
        var target = {
            x: player.x - player.cells[i].x + player.target.x,
            y: player.y - player.cells[i].y + player.target.y
        };
        var dist = Math.sqrt(Math.pow(target.y, 2) + Math.pow(target.x, 2));
        var deg = Math.atan2(target.y, target.x);
        var slowDown = 1;
        if(player.cells[i].speed <= 6.25) {
            slowDown = util.log(player.cells[i].mass, c.slowBase) - initMassLog + 1;
        }

        var deltaY = player.cells[i].speed * Math.sin(deg)/ slowDown;
        var deltaX = player.cells[i].speed * Math.cos(deg)/ slowDown;

        if(player.cells[i].speed > 6.25) {
            player.cells[i].speed -= 0.5;
        }
        if (dist < (50 + player.cells[i].radius)) {
            deltaY *= dist / (50 + player.cells[i].radius);
            deltaX *= dist / (50 + player.cells[i].radius);
        }
        if (!isNaN(deltaY)) {
            player.cells[i].y += deltaY;
        }
        if (!isNaN(deltaX)) {
            player.cells[i].x += deltaX;
        }
        // Find best solution.
        for(var j=0; j<player.cells.length; j++) {
            if(j != i && player.cells[i] !== undefined) {
                var distance = Math.sqrt(Math.pow(player.cells[j].y-player.cells[i].y,2) + Math.pow(player.cells[j].x-player.cells[i].x,2));
                var radiusTotal = (player.cells[i].radius + player.cells[j].radius);
                if(distance < radiusTotal) {
                    if(player.lastSplit > new Date().getTime() - 1000 * c.mergeTimer) {
                        if(player.cells[i].x < player.cells[j].x) {
                            player.cells[i].x--;
                        } else if(player.cells[i].x > player.cells[j].x) {
                            player.cells[i].x++;
                        }
                        if(player.cells[i].y < player.cells[j].y) {
                            player.cells[i].y--;
                        } else if((player.cells[i].y > player.cells[j].y)) {
                            player.cells[i].y++;
                        }
                    }
                    else if(distance < radiusTotal / 1.75) {
                        player.cells[i].mass += player.cells[j].mass;
                        player.cells.splice(j, 1);
                    }
                }
            }
        }
        if(player.cells.length > i) {
            // var borderCalc = player.cells[i].radius / 1.5;
            if (player.cells[i].x > c.gameWidth) {
                player.cells[i].x = 0;
            }
            if (player.cells[i].y > c.gameHeight) {
                player.cells[i].y = 0;
            }
            if (player.cells[i].x < 0) {
                player.cells[i].x = c.gameWidth;
            }
            if (player.cells[i].y < 0) {
                player.cells[i].y = c.gameHeight;
            }
            x += player.cells[i].x;
            y += player.cells[i].y;
        }
    }
    player.x = x/player.cells.length;
    player.y = y/player.cells.length;
}

function balanceMass() {
    var totalMass = food.length * c.foodMass +
        users
            .map(function(u) {return u.massTotal; })
            .reduce(function(pu,cu) { return pu+cu;}, 0);

    var massDiff = c.gameMass - totalMass;
    var maxFoodDiff = c.maxFood - food.length;
    var foodDiff = parseInt(massDiff / c.foodMass) - maxFoodDiff;
    var foodToAdd = Math.min(foodDiff, maxFoodDiff);
    var foodToRemove = -Math.max(foodDiff, maxFoodDiff);

    if (foodToAdd > 0) {
        addFood(foodToAdd);
    }
    else if (foodToRemove > 0) {
        removeFood(foodToRemove);
    }
}

io.on('connection', function (socket) {
    console.log('A user connected!', socket.handshake.query.type);

    var radius = c.playerRadius;
    var type = socket.handshake.query.type;
    var position = c.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(users, radius) : util.randomPosition(radius);

    var cells = [];
    var massTotal = 0;
    var chargeTotal = 0;
    if(type === 'player') {
        cells = [{
            mass: c.defaultPlayerMass,
            charge: 0,
            x: position.x,
            y: position.y,
            radius: radius
        }];
        massTotal = c.defaultPlayerMass;
    }

    var currentPlayer = {
        id: socket.id,
        x: position.x,
        y: position.y,
        cells: cells,
        massTotal: massTotal,
        chargeTotal: chargeTotal,
        hue: Math.round(Math.random() * 360),
        type: type,
        lastHeartbeat: new Date().getTime(),
        target: {
            x: 0,
            y: 0
        }
    };

    socket.on('gotit', function (player) {
        console.log('[INFO] Player ' + player.name + ' connecting!');

        if (util.findIndex(users, player.id) > -1) {
            console.log('[INFO] Player ID is already connected, kicking.');
            socket.disconnect();
        } else if (!util.validNick(player.name)) {
            socket.emit('kick', 'Invalid username.');
            socket.disconnect();
        } else {
            console.log('[INFO] Player ' + player.name + ' connected!');
            sockets[player.id] = socket;

            var position = c.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(users, radius) : util.randomPosition(radius);

            player.x = position.x;
            player.y = position.y;
            player.target.x = 0;
            player.target.y = 0;
            if(type === 'player') {
                player.cells = [{
                    mass: c.defaultPlayerMass,
                    x: position.x,
                    y: position.y,
                    radius: c.playerRadius,
                    charge: 0
                }];
                player.massTotal = c.defaultPlayerMass;
                player.chargeTotal = 0;
            }
            else {
                 player.cells = [];
                 player.massTotal = 0;
            }
            player.hue = 1;
            currentPlayer = player;
            currentPlayer.lastHeartbeat = new Date().getTime();
            users.push(currentPlayer);

            io.emit('playerJoin', { name: currentPlayer.name });

            socket.emit('gameSetup', {
                gameWidth: c.gameWidth,
                gameHeight: c.gameHeight
            });
            console.log('Total players: ' + users.length);
        }

    });

    socket.on('ping', function () {
        socket.emit('pong');
    });

    socket.on('windowResized', function (data) {
        currentPlayer.screenWidth = data.screenWidth;
        currentPlayer.screenHeight = data.screenHeight;
    });

    socket.on('respawn', function () {
        if (util.findIndex(users, currentPlayer.id) > -1)
            users.splice(util.findIndex(users, currentPlayer.id), 1);
        socket.emit('welcome', currentPlayer);
        console.log('[INFO] User ' + currentPlayer.name + ' respawned!');
    });

    socket.on('disconnect', function () {
        if (util.findIndex(users, currentPlayer.id) > -1)
            users.splice(util.findIndex(users, currentPlayer.id), 1);
        console.log('[INFO] User ' + currentPlayer.name + ' disconnected!');

        socket.broadcast.emit('playerDisconnect', { name: currentPlayer.name });
    });


    // Heartbeat function, update everytime.
    socket.on('0', function(target) {
        currentPlayer.lastHeartbeat = new Date().getTime();
        if (target.x !== currentPlayer.x || target.y !== currentPlayer.y) {
            currentPlayer.target = target;
        }
    });
    
});

function tickPlayer(currentPlayer) {
    if(currentPlayer.lastHeartbeat < new Date().getTime() - c.maxHeartbeatInterval) {
        sockets[currentPlayer.id].emit('kick', 'Last heartbeat received... It was over ' + c.maxHeartbeatInterval + '.');
        sockets[currentPlayer.id].disconnect();
    }

    movePlayer(currentPlayer);

    function funcFood(f) {
        return SAT.pointInCircle(new V(f.x, f.y), playerCircle);
    }

    function deleteFood(f) {
        food[f] = {};
        food.splice(f, 1);
    }

    function collisionCheck(collision) {
        if (collision.aUser.mass > collision.bUser.mass * 1.1  && collision.aUser.radius > Math.sqrt(Math.pow(collision.aUser.x - collision.bUser.x, 2) + Math.pow(collision.aUser.y - collision.bUser.y, 2))*1.75) {
            console.log('[DEBUG] Killing user: ' + collision.bUser.id);
            console.log('[DEBUG] Collision info:');
            console.log(collision);

            var numUser = util.findIndex(users, collision.bUser.id);
            if (numUser > -1) {
                if(users[numUser].cells.length > 1) {
                    users[numUser].massTotal -= collision.bUser.mass;
                    users[numUser].cells.splice(collision.bUser.num, 1);
                } else {
                    users.splice(numUser, 1);
                    io.emit('playerDied', { name: collision.bUser.name });
                    sockets[collision.bUser.id].emit('RIP');
                }
            }
            currentPlayer.massTotal += collision.bUser.mass;
            collision.aUser.mass += collision.bUser.mass;
        }
    }



    for(var z=0; z<currentPlayer.cells.length; z++) {
        var currentCell = currentPlayer.cells[z];
        var playerCircle = new C(
            new V(currentCell.x, currentCell.y),
            currentCell.radius
        );

        var foodEaten = food.map(funcFood)
            .reduce( function(a, b, c) { return b ? a.concat(c) : a; }, []);

        var chargeChange = 0;
        for(var i=0; i<foodEaten.length; i++) {
            chargeChange += food[foodEaten[i]].charge;
        }

        foodEaten.forEach(deleteFood);

        if(typeof(currentCell.speed) == "undefined")
            currentCell.speed = 6.25;
        
        currentCell.charge += chargeChange;
        currentPlayer.chargeTotal += chargeChange;
        
        var playerCollisions = [];

        playerCollisions.forEach(collisionCheck);
    }
}

function moveloop() {
    for (var i = 0; i < users.length; i++) {
        tickPlayer(users[i]);
    }
    for (i=0; i < food.length; i++) {
        moveFood(food[i]);
    }
}

function gameloop() {
    if (users.length > 0) {
        users.sort( function(a, b) { return Math.abs(b.chargeTotal) - Math.abs(a.chargeTotal); });

        var topUsers = [];

        for (var i = 0; i < Math.min(MAX_LEADER_BOARD_SIZE, users.length); i++) {
            if(users[i].type == 'player') {
                topUsers.push({
                    id: users[i].id,
                    name: users[i].name,
                    charge: Math.abs(users[i].chargeTotal)
                });
            }
        }
        updateLeaderBoard(topUsers);
    }
    balanceMass();
}

function updateLeaderBoard(topUsers) {
    if (leaderboard.length === 0) {
        leaderboard = topUsers;
        leaderboardChanged = true;
    }
    else {
        leaderboard = leaderboard.concat(topUsers);
        var dedupedLeaderboard = {};
        for (var i = 0; i < leaderboard.length; i++)
        {
            var key = leaderboard[i].name + "," + leaderboard[i].id;
            var score = leaderboard[i];

            if (typeof dedupedLeaderboard[key] === 'undefined') {
                dedupedLeaderboard[key] = score;
            }
            else if (dedupedLeaderboard[key].charge < score.charge) {
                dedupedLeaderboard[key] = score;
            }
        }

        var keys = Object.keys(dedupedLeaderboard);
        var finalLeaderboard = [];
        for (i = 0; i < keys.length; i++) {
            finalLeaderboard.push(dedupedLeaderboard[keys[i]]);
        }
        finalLeaderboard.sort( function(a, b) { return b.charge - a.charge; });
        finalLeaderboard = finalLeaderboard.slice(0, MAX_LEADER_BOARD_SIZE);

        leaderboard = finalLeaderboard;
        sendLeaderBoardToRedis();
        leaderboardChanged = true;
    }
}

function sendLeaderBoardToRedis()
{
    var leaderboardString = JSON.stringify(leaderboard);
    if (leaderboardString !== lastLeaderboardString) {
        client.set("leaderboard", leaderboardString);
        lastLeaderboardString = leaderboardString;
    }
}

function loadLeaderBoardFromRedis()
{
    client.get("leaderboard", function(err, reply) {
        if (reply) {
            leaderboard = JSON.parse(reply.toString());
        }
    });
}

// function isVisible(user, x, y, maxX, maxY) {
//     return x > user.x - user.screenWidth/2 - 20 &&
//            x < user.x + user.screenWidth/2 + 20 &&
//            y > user.y - user.screenHeight/2 - 20 &&
//            y < user.y + user.screenHeight/2 + 20;
// }

function isVisible(user, x, y, maxX, maxY) {
    return true;
}

function sendUpdates() {
    users.forEach( function(u) {
        // center the view if x/y is undefined, this will happen for spectators
        u.x = u.x || c.gameWidth / 2;
        u.y = u.y || c.gameHeight / 2;

        var visibleFood  = food
            .map(function(f) {
                if (isVisible(u, f.x, f.y, c.gameWidth, c.gameHeight)) {
                    return f;
                }
            })
            .filter(function(f) { return f; });

        var visibleCells  = users
            .map(function(f) {
                for(var z=0; z<f.cells.length; z++)
                {
                    if (isVisible(u, f.cells[z].x, f.cells[z].y, c.gameWidth, c.gameHeight)) {
                        z = f.cells.length;
                        if(f.id !== u.id) {
                            return {
                                id: f.id,
                                x: f.x,
                                y: f.y,
                                cells: f.cells,
                                massTotal: Math.round(f.massTotal),
                                hue: f.hue,
                                name: f.name,
                                chargeTotal: f.chargeTotal
                            };
                        } else {
                            return {
                                x: f.x,
                                y: f.y,
                                cells: f.cells,
                                massTotal: Math.round(f.massTotal),
                                hue: f.hue,
                                chargeTotal: f.chargeTotal
                            };
                        }
                    }
                }
            })
            .filter(function(f) { return f; });

        sockets[u.id].emit('serverTellPlayerMove', visibleCells, visibleFood);
        if (leaderboardChanged) {
            sockets[u.id].emit('leaderboard', {
                players: users.length,
                leaderboard: leaderboard
            });
        }
    });
    leaderboardChanged = false;
}

setInterval(moveloop, 1000 / 60);
setInterval(gameloop, 1000);
setInterval(sendUpdates, 1000 / c.networkUpdateFactor);

// Don't touch, IP configurations.
var ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP || '127.0.0.1';
var serverport = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || c.port;
if (process.env.OPENSHIFT_NODEJS_IP !== undefined) {
    http.listen( serverport, ipaddress, function() {
        console.log('[DEBUG] Listening on *:' + serverport);
    });
} else {
    http.listen( serverport, function() {
        console.log('[DEBUG] Listening on *:' + c.port);
    });
}
