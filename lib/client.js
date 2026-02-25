'use strict';
/*jslint browser: true */

var model = require('./model.js');
var comm = require('./comm.js');
var io = require('socket.io-client');
require('../app/browser/js/SimpleBoardUI.js');
require('./rules/rule.js');
require('./rules/RuleBgCasual.js'); // ICCJ: keep traditional only

/**
 * Backgammon client
 */
function Client(config) {

  this._socket = null;
  this._clientMsgSeq = 0;
  this._callbackList = {};
  this._msgSubscriptions = {};

  this.player = null;
  this.otherPlayer = null;
  this.match = null;
  this.rule = null;

  this.config = {
    'containerID': 'backgammon',
    'boardID': 'board',
    'rulePath': './rules/',
    'boardUI': '../app/browser/js/SimpleBoardUI.js',
    'playerName': null
  };

  this.init = function (config) {

    for (var attrname in config) {
      this.config[attrname] = config[attrname];
    }

    var boardUIClass = require(this.config.boardUI);
    this.boardUI = new boardUIClass(this);
    this.boardUI.init();

    this._openSocket();
  };


  this._openSocket = function () {

    var self = this;

    var serverURL = this.config.serverURL;

    if (!serverURL) {
      serverURL = window.location.host;
    }

    this._socket = io.connect(serverURL, {'force new connection': true});

    this._socket.on(comm.Message.CONNECT, function(){

      self.handleConnect();

      self.updateUI();

    });

    var m = comm.Message;

    var messages = [

      m.CREATE_GUEST,
      m.GET_MATCH_LIST,
      m.CREATE_MATCH,
      m.JOIN_MATCH,
      m.ROLL_DICE,
      m.MOVE_PIECE,
      m.EVENT_PLAYER_JOINED,
      m.EVENT_TURN_START,
      m.EVENT_DICE_ROLL,
      m.EVENT_PIECE_MOVE,
      m.EVENT_MATCH_START,
      m.EVENT_GAME_OVER,
      m.EVENT_MATCH_OVER,
      m.EVENT_GAME_RESTART,
      m.EVENT_UNDO_MOVES

    ];

    var createHandler = function(msg){

      return function(params) {

        self.handleMessage(msg, params);

      };

    };

    for (var i = 0; i < messages.length; i++) {

      this._socket.on(messages[i], createHandler(messages[i]));

    }

  };


  this.sendMessage = function (msg, params, callback) {

    params = params || {};

    params.clientMsgSeq = ++this._clientMsgSeq;

    this._callbackList[params.clientMsgSeq] = callback;

    console.log('Sending message ' + msg + ' with ID ' + params.clientMsgSeq);

    this._socket.emit(msg, params);

  };


  /**
   * ICCJ FIX:
   * Send playerName during guest creation
   */
  this.handleConnect = function () {

    console.log('Client connected');

    var params = {};

    if (this.player) {

      params.playerID = this.player.id;

    }

    if (this.config.playerName) {

      params.playerName = this.config.playerName;

    }

    this.sendMessage(

      comm.Message.CREATE_GUEST,

      params

    );

  };


  this.handleMessage = function (msg, params) {

    console.log('Reply/event received: ' + msg);

    console.log(params);

    if ((params) && (params.match) && (this.match) &&
       (this.match.id == params.match.id)) {

      this.updateMatch(params.match);

    }

    if (msg == comm.Message.CREATE_GUEST) {

      this.handleCreateGuest(params);

    }

    else if (msg == comm.Message.CREATE_MATCH) {

      this.handleCreateMatch(params);

    }

    else if (msg == comm.Message.JOIN_MATCH) {

      this.handleJoinMatch(params);

    }

    else if (msg == comm.Message.EVENT_MATCH_START) {

      this.handleEventMatchStart(params);

    }

    else if (msg == comm.Message.EVENT_GAME_OVER) {

      this.handleEventGameOver(params);

    }

    else if (msg == comm.Message.EVENT_MATCH_OVER) {

      this.handleEventMatchOver(params);

    }

    else if (msg == comm.Message.EVENT_GAME_RESTART) {

      this.handleEventGameRestart(params);

    }

    else if (msg == comm.Message.EVENT_UNDO_MOVES) {

      this.handleEventUndoMoves(params);

    }

    if (params.clientMsgSeq) {

      var callback = this._callbackList[params.clientMsgSeq];

      if (callback) {

        callback(msg, params.clientMsgSeq, params);

        delete this._callbackList[params.clientMsgSeq];

      }

    }

    this._notify(msg, params);

    this.updateUI();

  };


  this.handleCreateGuest = function (params) {

    this.player = params.player;

    document.cookie = 'player_id=' + this.player.id;

  };


  this.handleCreateMatch = function (params) {

    if (!params.result) return;

    this.updatePlayer(params.player);

    this.updateMatch(params.match);

    this.updateRule(this.loadRule(params.ruleName));

    this.resetBoard(this.match, this.rule);

  };


  this.handleJoinMatch = function (params) {

    if (!params.result) return;

    this.updatePlayer(params.guest);

    this.updateOtherPlayer(params.host);

    this.updateMatch(params.match);

    this.updateRule(this.loadRule(params.ruleName));

    this.resetBoard(this.match, this.rule);

  };


  this.handleEventMatchStart = function (params) {

    console.log('Match started');

    if (model.Match.isHost(params.match, this.player)) {

      this.updatePlayer(params.match.host);

      this.updateOtherPlayer(params.match.guest);

    }

    else {

      this.updatePlayer(params.match.guest);

      this.updateOtherPlayer(params.match.host);

    }

    this.updateMatch(params.match);

    this.updateRule(this.loadRule(params.match.ruleName));

    this.resetBoard(this.match, this.rule);

  };


  this.loadRule = function (ruleName) {

    var fileName = model.Utils.sanitizeName(ruleName);

    var file = this.config.rulePath + fileName + '.js';

    var rule = require(file);

    rule.name = fileName;

    return rule;

  };


  this.resetBoard = function (match, rule) {

    this.boardUI.resetBoard(match, rule);

  };


  this.updatePlayer = function (player) {

    this.player = player;

  };


  this.updateOtherPlayer = function (player) {

    this.otherPlayer = player;

  };


  this.updateMatch = function (match) {

    this.match = match;

    this.boardUI.match = match;

  };


  this.updateRule = function (rule) {

    this.rule = rule;

    this.boardUI.rule = rule;

  };


  this.updateUI = function () {

    this.boardUI.updateControls();

    this.boardUI.updateScoreboard();

  };


  this.subscribe = function (msgID, callback) {

    this._msgSubscriptions[msgID] = this._msgSubscriptions[msgID] || [];

    this._msgSubscriptions[msgID].push(callback);

  };


  this._notify = function (msg, params) {

    var list = this._msgSubscriptions[msg];

    if (!list) return;

    for (var i = 0; i < list.length; i++) {

      list[i](msg, params);

    }

  };


  /**
   * ICCJ INVITE ONLY FUNCTIONS
   */


  this.reqCreateMatchInviteOnly = function(options, callback){

    this.sendMessage(

      comm.Message.CREATE_MATCH,

      {

        playerName: options.playerName,

        hostSlug: options.hostSlug,

        ruleName: "RuleBgCasual"

      },

      callback

    );

  };


  this.reqJoinMatchByHostSlug = function(hostSlug, callback){

    this.sendMessage(

      comm.Message.JOIN_MATCH,

      {

        hostSlug: hostSlug

      },

      callback

    );

  };


  this.reqRollDice = function (callback) {

    this.sendMessage(comm.Message.ROLL_DICE, undefined, callback);

  };


  this.reqConfirmMoves = function (callback) {

    this.sendMessage(comm.Message.CONFIRM_MOVES, undefined, callback);

  };


  this.reqMove = function(piece, steps, callback){

    this.sendMessage(

      comm.Message.MOVE_PIECE,

      {

        piece: piece,

        steps: steps,

        moveSequence: this.match.currentGame.moveSequence

      },

      callback

    );

  };


  this.resizeUI = function () {

    this.boardUI.resizeUI();

  };


  this.init(config);

}

module.exports.Client = Client;
