'use strict';
/*jslint browser: true */
/*global fitText: false */
/*global ohSnap: false */

var $ = require('jquery');
var fittext = require('jquery-fittext');
var cookie = require('js-cookie');
window.jQuery = window.$ = $;

var bootstrap = require('bootstrap/dist/js/bootstrap.bundle.js');
var clipboard = require('clipboard');
var cl = require('../../../lib/client');
var comm = require('../../../lib/comm.js');
var model = require('../../../lib/model.js');

require('../../../lib/rules/rule.js');
require('../../../lib/rules/RuleBgCasual.js'); // ONLY traditional backgammon

function slugify(s) {
  s = (s || '').toString().trim().toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || '';
}

function readQueryParam(name) {
  try {
    var params = new URLSearchParams(window.location.search || '');
    return params.get(name) || '';
  } catch (e) {
    // fallback
    var raw = (location.search.split(name + '=')[1] || '').split('&')[0];
    try { raw = decodeURIComponent(raw); } catch (e2) {}
    return raw || '';
  }
}

function App() {
  this._config = {};
  this._isWaiting = false;
  this._isChallenging = false;
  this._currentView = 'index';

  this.setIsWaiting = function (value) { this._isWaiting = value; };
  this.setIsChallenging = function (value) { this._isChallenging = value; };
  this.setCurrentView = function (name) { this._currentView = name; };

  this.updateView = function () {
    if (this._isChallenging) {
      $('#waiting-overlay .challenge').show();
    } else {
      $('#waiting-overlay .challenge').hide();
    }

    if (this._isWaiting) {
      $('#waiting-overlay').show();
    } else {
      $('#waiting-overlay').hide();
    }

    $('#game-view').hide();
    $('#index-view').hide();
    $('#github-ribbon').hide();

    if (this._currentView === 'index') {
      $('#index-view').show();
      $('#github-ribbon').show();
    } else if (this._currentView === 'game') {
      $('#game-view').show();
    }
  };

  /**
   * ICCJ: we force RuleBgCasual
   */
  this.getSelectedRuleName = function () {
    return 'RuleBgCasual';
  };

  this.init = function (config) {
    var self = this;
    this._config = config;

    // Hide rule selector UI if it exists (we’re not using it)
    try { $('#rule-selector').hide(); } catch (e) {}

    $('#game-result-overlay').click(function () {
      $('#game-result-overlay').hide();
    });

    // Determine our display name (prompt once)
    var storedName = cookie.get('iccj_bg_name') || '';
    var suggested = storedName;

    // If user came via invite link, don’t use host slug as their display name.
    // Still allow them to pick a name.
    if (!suggested) suggested = '';

    if (!suggested) {
      suggested = prompt('Enter your name for backgammon (e.g., Hillel):', '') || '';
      suggested = (suggested || '').toString().trim();
      if (suggested) cookie.set('iccj_bg_name', suggested, { expires: 365 });
    }

    // Initialize game client with playerName so server can store it on CREATE_GUEST
    var client = new cl.Client(Object.assign({}, this._config, {
      playerName: suggested
    }));

    // When a match starts, ALWAYS go to game view (fixes the “host still waiting” problem)
    client.subscribe(comm.Message.EVENT_MATCH_START, function (msg, params) {
      self.setIsWaiting(false);
      self.setIsChallenging(false);
      self.setCurrentView('game');
      self.updateView();
      client.resizeUI();
    });

    client.subscribe(comm.Message.EVENT_MATCH_OVER, function (msg, params) {
      self.setIsWaiting(false);
      self.setIsChallenging(false);
      self.setCurrentView('index');
      self.updateView();
    });

    client.subscribe(comm.Message.EVENT_PLAYER_JOINED, function (msg, params) {
      self.setIsWaiting(false);
      self.setIsChallenging(false);
      self.setCurrentView('game');
      self.updateView();
      client.resizeUI();
    });

    client.subscribe(comm.Message.JOIN_MATCH, function (msg, params) {
      if (!params.result) return;
      self.setIsWaiting(false);
      self.setIsChallenging(false);
      self.setCurrentView('game');
      self.updateView();
      client.resizeUI();
    });

    // On create guest, auto-join if we have ?host=...
    client.subscribe(comm.Message.CREATE_GUEST, function (msg, params) {
      if (params.reconnected) return;

      var hostSlug = readQueryParam('host').trim().toLowerCase();
      hostSlug = slugify(hostSlug);

      if (hostSlug) {
        // Guest auto-joins by hostSlug
        self.setIsWaiting(true);
        self.setIsChallenging(false);
        self.updateView();

        client.reqJoinMatchByHostSlug(hostSlug, function () {
          // Server will emit EVENT_MATCH_START when the join succeeds.
        });

        // Clean URL
        if (history.pushState) {
          history.pushState(null, '', '/');
        }
      }
    });

    // Remove random button if it exists
    try { $('#btn-play-random').hide(); } catch (e) {}

    // Invite button
    $('#btn-challenge-friend').off('click').on('click', function (e) {
      self.setIsChallenging(false);
      self.setIsWaiting(true);
      self.updateView();

      var displayName = (cookie.get('iccj_bg_name') || suggested || '').toString().trim();
      if (!displayName) displayName = 'Host';

      var hostSlug = slugify(displayName);

      client.reqCreateMatchInviteOnly({
        playerName: displayName,
        hostSlug: hostSlug
      }, function (msg, clientMsgSeq, reply) {
        if (!reply || !reply.result) {
          self.setIsWaiting(false);
          self.setIsChallenging(false);
          self.updateView();
          return;
        }

        var serverURL = self._config.serverURL;
        if (!serverURL) {
          serverURL = window.location.protocol + '//' + window.location.host + '/';
        }

        $('#challenge-link').val(serverURL + '?host=' + encodeURIComponent(hostSlug));

        self.setIsWaiting(false);
        self.setIsChallenging(true);
        self.updateView();
      });
    });

    $(window).resize(function () {
      client.resizeUI();
    });
  };
}

var app = new App();

$(document).ready(function () {
  new clipboard('.btn-copy');
  var config = require('./config');
  app.init(config);
});
