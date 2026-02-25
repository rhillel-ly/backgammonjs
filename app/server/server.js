'use strict';

var path = require('path');
var express = require('express');
var expressServer = express();
var http = require('http').Server(expressServer);
var io = require('socket.io')(http);
var comm = require('../../lib/comm.js');
var model = require('../../lib/model.js');
// Keep queue_manager require so random can be re-enabled later if desired.
var queue_manager = require('./queue_manager.js');
require('../../lib/rules/rule.js');

/**
 * ICCJ: safe slugify
 */
function iccjSlugify(s) {
  s = (s || '').toString().trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s || '';
}

/**
 * ICCJ: match slug host-vs-guest
 */
function iccjMatchSlug(hostName, guestName) {
  var h = iccjSlugify(hostName);
  var g = iccjSlugify(guestName);
  if (h && g) return h + '-vs-' + g;
  return h || g || '';
}

/**
 * ICCJ: display name cleanup (don’t allow insane strings)
 */
function iccjSafeDisplayName(name) {
  name = (name || '').toString().trim();
  if (!name) return '';
  // Allow letters, numbers, spaces, apostrophes, hyphen, dot
  name = name.replace(/[^A-Za-z0-9 .'\-]/g, '');
  name = name.replace(/\s+/g, ' ').trim();
  // reasonable length
  if (name.length > 40) name = name.slice(0, 40).trim();
  return name;
}

/**
 * Backgammon server.
 */
function Server() {
  this.clients = {};
  this.players = [];
  this.matches = [];

  // Keep this around (not used in invite-only mode)
  this.queueManager = new queue_manager.QueueManager();

  this.config = require('./config');

  /**
   * Load enabled rules.
   * ICCJ: we will force RuleBgCasual server-side even if config lists others.
   */
  this.loadRules = function () {
    // Load whatever config says, but we will *use* RuleBgCasual only.
    for (var i = 0; i < this.config.enabledRules.length; i++) {
      var ruleName = this.config.enabledRules[i];
      require(this.config.rulePath + ruleName + '.js');
    }
  };

  this.snapshotServer = function () {
    if (db) {
      console.log("Saving server state...");

      var players = db.collection('players');
      players.remove();
      players.insert(this.players);

      var matches = db.collection('matches');
      matches.remove();
      matches.insert(this.matches);

      console.log("State saved.");
    }
  };

  this.restoreServer = function () {
    if (db) {
      var self = this;
      console.log("Restoring server state...");

      var players = db.collection('players');
      var matches = db.collection('matches');
      if (!players || !matches) return;

      var matchesCursor = matches.find();
      matchesCursor.each(function (err, item) {
        if (item == null) return;

        if (item.currentGame && item.currentGame.state) {
          model.State.rebuildRefs(item.currentGame.state);
        }

        // Backfill ICCJ fields if missing
        if (!item.hostSlug && item.hostName) item.hostSlug = iccjSlugify(item.hostName);
        if (!item.slug) item.slug = iccjMatchSlug(item.hostName, item.guestName);
        if (!item.name) {
          if (item.hostName && item.guestName) item.name = item.hostName + ' vs ' + item.guestName;
          else item.name = item.hostName || ('Match ' + item.id);
        }

        self.matches.push(item);
      });

      var playersCursor = players.find();
      playersCursor.each(function (err, item) {
        if (item == null) return;
        self.players.push(item);
      });

      for (var i = 0; i < self.matches.length; i++) {
        var match = self.matches[i];

        if (match.host && match.host.id) match.host = self.getPlayerByID(match.host.id);
        if (match.guest && match.guest.id) match.guest = self.getPlayerByID(match.guest.id);
      }

      console.log("State restored.");
    }
  };

  this.run = function () {
    var self = this;

    this.loadRules();
    this.restoreServer();

    expressServer.use(express.static(path.join(__dirname, '../browser')));

    io.on('connection', function (socket) {
      console.log('Client connected');
      self.clients[socket.id] = socket;

      socket.on('disconnect', function () {
        try {
          self.handleDisconnect(socket);
        } catch (e) {
          console.log(e);
        }
      });

      // Subscribe for client requests:
      var m = comm.Message;

      // ICCJ: invite-only. Do NOT subscribe to PLAY_RANDOM here.
      var messages = [
        m.CREATE_GUEST,
        m.GET_MATCH_LIST,
        m.CREATE_MATCH,
        m.JOIN_MATCH,
        m.ROLL_DICE,
        m.MOVE_PIECE,
        m.CONFIRM_MOVES,
        m.UNDO_MOVES,
        m.RESIGN_GAME,
        m.RESIGN_MATCH
      ];

      var createHandler = function (msg) {
        return function (params) {
          try {
            self.handleRequest(msg, socket, params);
          } catch (e) {
            console.log(e);
          }
        };
      };

      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        socket.on(msg, createHandler(msg));
      }
    });

    var host = process.env.OPENSHIFT_NODEJS_IP || comm.Protocol.BindAddress;
    var port = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || comm.Protocol.Port;
    http.listen(port, host, function () {
      console.log('listening on *:' + port);
    });
  };

  this.getSocketMatch = function (socket) { return socket.match; };
  this.getSocketGame = function (socket) { return socket.game; };
  this.getSocketPlayer = function (socket) { return socket.player; };
  this.getSocketRule = function (socket) { return socket.rule; };

  this.setSocketMatch = function (socket, match) { socket.match = match; };
  this.setSocketGame = function (socket, game) { socket.game = game; };
  this.setSocketPlayer = function (socket, player) { socket.player = player; };
  this.setSocketRule = function (socket, rule) { socket.rule = rule; };

  this.sendMessage = function (socket, msg, params) {
    console.log('Sending message ' + msg + ' to client ' + socket.id);
    socket.emit(msg, params);
  };

  this.sendPlayerMessage = function (player, msg, params) {
    var socket = this.clients[player.socketID];
    if (!socket) return;
    this.sendMessage(socket, msg, params);
  };

  this.sendMatchMessage = function (match, msg, params) {
    for (var i = 0; i < match.players.length; i++) {
      var player = this.getPlayerByID(match.players[i]);
      if (player) this.sendPlayerMessage(player, msg, params);
    }
  };

  this.sendOthersMessage = function (match, exceptPlayerID, msg, params) {
    for (var i = 0; i < match.players.length; i++) {
      if (match.players[i] === exceptPlayerID) continue;
      var player = this.getPlayerByID(match.players[i]);
      if (player) this.sendPlayerMessage(player, msg, params);
    }
  };

  this.handleDisconnect = function (socket) {
    console.log('Client disconnected');
    var player = this.getSocketPlayer(socket);
    if (!player) return;

    // invite-only: no queue needed, but keep cleanup if queue exists
    this.queueManager.removeFromAll(player);
  };

  this.handleRequest = function (msg, socket, params) {
    console.log('Request received: ' + msg);

    var reply = { 'result': false };

    if (params && params.clientMsgSeq) reply.clientMsgSeq = params.clientMsgSeq;

    if (msg === comm.Message.CREATE_GUEST) {
      reply.result = this.handleCreateGuest(socket, params, reply);
    }
    else if (msg === comm.Message.GET_MATCH_LIST) {
      reply.result = this.handleGetMatchList(socket, params, reply);
    }
    else if (msg === comm.Message.CREATE_MATCH) {
      reply.result = this.handleCreateMatch(socket, params, reply);
    }
    else if (msg === comm.Message.JOIN_MATCH) {
      reply.result = this.handleJoinMatch(socket, params, reply);
    }
    else if (msg === comm.Message.ROLL_DICE) {
      reply.result = this.handleRollDice(socket, params, reply);
    }
    else if (msg === comm.Message.MOVE_PIECE) {
      reply.result = this.handleMovePiece(socket, params, reply);
    }
    else if (msg === comm.Message.CONFIRM_MOVES) {
      reply.result = this.handleConfirmMoves(socket, params, reply);
    }
    else if (msg === comm.Message.UNDO_MOVES) {
      reply.result = this.handleUndoMoves(socket, params, reply);
    }
    else if (msg === comm.Message.RESIGN_GAME) {
      reply.result = this.handleResignGame(socket, params, reply);
    }
    else if (msg === comm.Message.RESIGN_MATCH) {
      reply.result = this.handleResignMatch(socket, params, reply);
    }
    else {
      console.log('Unknown message!');
      return;
    }

    var match = this.getSocketMatch(socket);
    if (match) reply.match = match;

    if (reply.errorMessage) console.log(reply.errorMessage);

    this.sendMessage(socket, msg, reply);

    if (reply.sendAfter) {
      reply.sendAfter();
      delete reply.sendAfter;
    }

    this.snapshotServer();
  };

  /**
   * CREATE_GUEST
   * ICCJ: accept params.playerName (display) and store on player.name (sanitized)
   */
  this.handleCreateGuest = function (socket, params, reply) {
    console.log('Creating guest player');

    var desiredName = (params && params.playerName) ? iccjSafeDisplayName(params.playerName) : '';

    var player = null;

    if (!this.getSocketPlayer(socket) && params && params.playerID) {
      player = this.getPlayerByID(params.playerID);
      if (player) player.socketID = socket.id;
    }
    else if (socket.handshake.headers.cookie) {
      var cookieStr = socket.handshake.headers.cookie;
      var m = cookieStr.match(/\bplayer_id=([0-9]+)/);
      var playerID = m ? m[1] : null;
      player = this.getPlayerByID(playerID);
    }

    if (player) {
      // Update name if provided
      if (desiredName) player.name = desiredName;

      // Reconnect into pending match if exists
      var match = this.getMatchByID(player.currentMatch);
      if (match && !match.isOver) {
        var rule = model.Utils.loadRule(match.ruleName);
        player.socketID = socket.id;
        this.setSocketPlayer(socket, player);
        this.setSocketMatch(socket, match);
        this.setSocketRule(socket, rule);

        var self = this;
        reply.sendAfter = function () {
          self.sendPlayerMessage(player, comm.Message.EVENT_MATCH_START, { 'match': match });
        };

        reply.player = player;
        reply.reconnected = true;
        return true;
      }
    }

    player = model.Player.createNew();
    player.name = desiredName || ('Player ' + player.id);
    this.players.push(player);

    player.socketID = socket.id;
    this.setSocketPlayer(socket, player);

    reply.player = player;
    reply.reconnected = false;

    return true;
  };

  /**
   * GET_MATCH_LIST
   * ICCJ: include match.name + match.slug + match.hostSlug
   */
  this.handleGetMatchList = function (socket, params, reply) {
    console.log('List of matches requested');

    var list = [];
    for (var i = 0; i < this.matches.length; i++) {
      var match = this.matches[i];
      // show only non-over matches
      if (match.isOver) continue;
      list.push({
        id: match.id,
        name: match.name || ('Match ' + match.id),
        slug: match.slug || null,
        hostSlug: match.hostSlug || null,
        isOpen: !match.guest
      });
    }

    reply.list = list;
    return true;
  };

  /**
   * CREATE_MATCH (invite-only)
   * params: { playerName?, hostSlug? }
   * - forces RuleBgCasual only
   * - creates (or reuses) one open match per hostSlug
   */
  this.handleCreateMatch = function (socket, params, reply) {
    console.log('Creating new match', params);

    var player = this.getSocketPlayer(socket);
    if (!player) {
      reply.errorMessage = 'Player not found!';
      return false;
    }

    // Force traditional rules only
    var ruleName = 'RuleBgCasual';
    var rule = model.Utils.loadRule(ruleName);

    // Allow UI to set/override display name
    if (params && params.playerName) {
      var dn = iccjSafeDisplayName(params.playerName);
      if (dn) player.name = dn;
    }

    // Determine hostSlug (prefer provided, else derived from name)
    var hostSlug = '';
    if (params && params.hostSlug) hostSlug = iccjSlugify(params.hostSlug);
    if (!hostSlug) hostSlug = iccjSlugify(player.name);

    if (!hostSlug) {
      reply.errorMessage = 'Host name is required.';
      return false;
    }

    // Reuse existing open match for this hostSlug
    var existing = this.getOpenMatchByHostSlug(hostSlug);
    if (existing) {
      this.setSocketMatch(socket, existing);
      this.setSocketRule(socket, rule);

      reply.player = player;
      reply.ruleName = ruleName;
      reply.matchID = existing.id;
      reply.hostSlug = hostSlug;
      reply.slug = existing.slug || hostSlug;
      reply.matchName = existing.name || player.name;
      reply.reused = true;
      return true;
    }

    var match = model.Match.createNew(rule);

    // ICCJ metadata
    match.ruleName = ruleName;
    match.hostName = player.name;
    match.hostSlug = hostSlug;
    match.guestName = null;
    match.slug = hostSlug; // until guest joins
    match.name = match.hostName || ('Match ' + match.id);

    model.Match.addHostPlayer(match, player);
    player.currentMatch = match.id;
    player.currentPieceType = model.PieceType.WHITE;

    this.matches.push(match);

    // Create game but do not start until guest joins
    model.Match.createNewGame(match, rule);

    this.setSocketMatch(socket, match);
    this.setSocketRule(socket, rule);

    reply.player = player;
    reply.ruleName = ruleName;
    reply.matchID = match.id;
    reply.hostSlug = hostSlug;
    reply.slug = match.slug;
    reply.matchName = match.name;

    return true;
  };

  /**
   * JOIN_MATCH (invite-only)
   * params: { hostSlug } OR { matchID }
   */
  this.handleJoinMatch = function (socket, params, reply) {
    console.log('Joining match', params);

    if (!params) params = {};

    var match = null;

    if (params.hostSlug) {
      match = this.getOpenMatchByHostSlug(iccjSlugify(params.hostSlug));
    } else if (params.matchID) {
      match = this.getMatchByID(params.matchID);
    }

    if (!match) {
      reply.errorMessage = 'Match not found!';
      return false;
    }

    if (match.guest) {
      reply.errorMessage = 'Match is full!';
      return false;
    }

    var guestPlayer = this.getSocketPlayer(socket);
    if (!guestPlayer) {
      reply.errorMessage = 'Player not found!';
      return false;
    }

    // Force traditional rules only
    var rule = model.Utils.loadRule('RuleBgCasual');

    model.Match.addGuestPlayer(match, guestPlayer);
    guestPlayer.currentMatch = match.id;
    guestPlayer.currentPieceType = model.PieceType.BLACK;

    // Finalize match metadata now that both names exist
    match.hostName = match.hostName || (match.host && match.host.name) || 'Host';
    match.guestName = guestPlayer.name || 'Guest';
    match.slug = iccjMatchSlug(match.hostName, match.guestName);
    match.name = match.hostName + ' vs ' + match.guestName;

    // Start match
    match.currentGame.hasStarted = true;
    match.currentGame.turnPlayer = match.host;
    match.currentGame.turnNumber = 1;

    this.setSocketMatch(socket, match);
    this.setSocketRule(socket, rule);

    reply.ruleName = 'RuleBgCasual';
    reply.host = match.host;
    reply.guest = guestPlayer;
    reply.slug = match.slug;
    reply.matchName = match.name;

    var self = this;
    reply.sendAfter = function () {
      self.sendMatchMessage(match, comm.Message.EVENT_MATCH_START, { 'match': match });
    };

    return true;
  };

  // ---- Original gameplay handlers below (UNCHANGED) ----

  this.handleRollDice = function (socket, params, reply) {
    console.log('Rolling dice');

    var match = this.getSocketMatch(socket);
    var player = this.getSocketPlayer(socket);
    var rule = this.getSocketRule(socket);

    var game = match.currentGame;

    if (!game) {
      reply.errorMessage = 'Match with ID ' + match.id + ' has no current game!';
      return false;
    }

    if (!game.hasStarted) {
      reply.errorMessage = 'Game with ID ' + game.id + ' is not yet started!';
      return false;
    }

    if ((!game.turnPlayer) || (game.turnPlayer.id !== player.id)) {
      reply.errorMessage = 'Cannot roll dice it isn\'t player ' + player.id + ' turn!';
      return false;
    }

    if (model.Game.diceWasRolled(game)) {
      reply.errorMessage = 'Dice was already rolled!';
      return false;
    }

    var dice = rule.rollDice(game);
    game.turnDice = dice;

    model.Game.snapshotState(match.currentGame);

    reply.player = game.turnPlayer;
    reply.dice = dice;

    this.sendOthersMessage(match, player.id, comm.Message.EVENT_DICE_ROLL, { 'match': match });

    return true;
  };

  this.handleMovePiece = function (socket, params, reply) {
    console.log('Moving a piece', params);

    var match = this.getSocketMatch(socket);
    var player = this.getSocketPlayer(socket);
    var rule = this.getSocketRule(socket);

    if (!params.piece) {
      reply.errorMessage = 'No piece selected!';
      return false;
    }

    if (!match.currentGame) {
      reply.errorMessage = 'Match created, but current game is null!';
      return false;
    }

    if (params.moveSequence < match.currentGame.moveSequence) {
      reply.errorMessage = 'This move has already been played!';
      return false;
    }

    if (!rule.validateMove(match.currentGame, player, params.piece, params.steps)) {
      reply.errorMessage = 'Requested move is not valid!';
      return false;
    }

    var actionList = rule.getMoveActions(match.currentGame.state, params.piece, params.steps);
    if (actionList.length === 0) {
      reply.errorMessage = 'Requested move is not allowed!';
      return false;
    }

    try {
      rule.applyMoveActions(match.currentGame.state, actionList);
      rule.markAsPlayed(match.currentGame, params.steps);

      match.currentGame.moveSequence++;

      reply.piece = params.piece;
      reply.type = params.type;
      reply.steps = params.steps;
      reply.moveActionList = actionList;

      this.sendMatchMessage(match, comm.Message.EVENT_PIECE_MOVE, {
        'match': match,
        'piece': params.piece,
        'type': params.type,
        'steps': params.steps,
        'moveActionList': actionList
      });

      return true;
    } catch (e) {
      reply.piece = params.piece;
      reply.type = params.type;
      reply.steps = params.steps;
      reply.moveActionList = [];

      if (process.env.DEBUG) throw e;
      return false;
    }
  };

  this.handleConfirmMoves = function (socket, params, reply) {
    console.log('Confirming piece movement', params);

    var match = this.getSocketMatch(socket);
    var player = this.getSocketPlayer(socket);
    var rule = this.getSocketRule(socket);

    if (!rule.validateConfirm(match.currentGame, player)) {
      reply.errorMessage = 'Confirming moves is not allowed!';
      return false;
    }

    if (rule.hasWon(match.currentGame.state, player)) {
      this.endGame(socket, player, false, reply);
    } else {
      rule.nextTurn(match);
      this.sendMatchMessage(match, comm.Message.EVENT_TURN_START, { 'match': match });
    }

    return true;
  };

  this.handleUndoMoves = function (socket, params, reply) {
    console.log('Undo moves', params);

    var match = this.getSocketMatch(socket);
    var player = this.getSocketPlayer(socket);
    var rule = this.getSocketRule(socket);

    if (!rule.validateUndo(match.currentGame, player)) {
      reply.errorMessage = 'Undo moves is not allowed!';
      return false;
    }

    model.Game.restoreState(match.currentGame);

    this.sendMatchMessage(match, comm.Message.EVENT_UNDO_MOVES, { 'match': match });

    return true;
  };

  this.handleResignGame = function (socket, params, reply) {
    console.log('Resign game', params);

    var match = this.getSocketMatch(socket);
    var player = this.getSocketPlayer(socket);
    var otherPlayer = (model.Match.isHost(match, player)) ? match.guest : match.host;

    this.endGame(socket, otherPlayer, true, reply);
    return true;
  };

  this.handleResignMatch = function (socket, params, reply) {
    console.log('Resign match', params);

    var match = this.getSocketMatch(socket);
    var player = this.getSocketPlayer(socket);
    var otherPlayer = (model.Match.isHost(match, player)) ? match.guest : match.host;

    var self = this;
    reply.sendAfter = function () {
      self.sendMatchMessage(match, comm.Message.EVENT_MATCH_OVER, {
        'match': match,
        'winner': otherPlayer,
        'resigned': true
      });
    };

    return true;
  };

  this.endGame = function (socket, winner, resigned, reply) {
    var self = this;

    var match = this.getSocketMatch(socket);
    var rule = this.getSocketRule(socket);

    var score = rule.getGameScore(match.currentGame.state, winner);
    match.score[winner.currentPieceType] += score;

    if (match.score[winner.currentPieceType] >= match.length) {
      match.isOver = true;
    }

    if (match.isOver) {
      reply.sendAfter = function () {
        self.sendMatchMessage(match, comm.Message.EVENT_MATCH_OVER, {
          'match': match,
          'winner': winner,
          'resigned': resigned
        });
      };
    } else {
      var game = model.Match.createNewGame(match, rule);
      game.hasStarted = true;
      game.turnPlayer = winner;
      game.turnNumber = 1;

      reply.sendAfter = function () {
        self.sendMatchMessage(match, comm.Message.EVENT_GAME_OVER, {
          'match': match,
          'winner': winner,
          'resigned': resigned
        });

        self.sendMatchMessage(match, comm.Message.EVENT_GAME_RESTART, {
          'match': match,
          'game': match.currentGame,
          'resigned': resigned
        });
      };
    }

    return true;
  };

  this.getPlayerByID = function (id) {
    for (var i = 0; i < this.players.length; i++) {
      if (this.players[i].id == id) return this.players[i];
    }
    return null;
  };

  this.getMatchByID = function (id) {
    for (var i = 0; i < this.matches.length; i++) {
      if (this.matches[i].id == id) return this.matches[i];
    }
    return null;
  };

  /**
   * ICCJ: find an OPEN match by hostSlug
   */
  this.getOpenMatchByHostSlug = function (hostSlug) {
    hostSlug = iccjSlugify(hostSlug);
    if (!hostSlug) return null;

    for (var i = 0; i < this.matches.length; i++) {
      var match = this.matches[i];
      if (match.isOver) continue;
      if (match.guest) continue; // only open matches
      if ((match.hostSlug && iccjSlugify(match.hostSlug) === hostSlug) ||
          (match.hostName && iccjSlugify(match.hostName) === hostSlug) ||
          (match.host && match.host.name && iccjSlugify(match.host.name) === hostSlug)) {
        return match;
      }
    }
    return null;
  };
}

var server = new Server();

var mongo = require('mongodb').MongoClient;
var db = null;

if (process.env.MONGODB_URI) {
  console.log("Connecting to DB");
  mongo.connect(process.env.MONGODB_URI, function (err, database) {
    if (err) {
      if (process.env.DEBUG) throw err;
      return;
    }

    db = database;
    console.log("Connected to DB");
    server.run();
  });
} else {
  server.run();
}
