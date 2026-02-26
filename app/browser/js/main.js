'use strict';

var $ = require('jquery');
var clipboard = require('clipboard');
var cl = require('../../../lib/client');

function generateRandomName(){

var chars =
'abcdefghijklmnopqrstuvwxyz0123456789';

var name='player_';

for(var i=0;i<8;i++){

name+=chars.charAt(
Math.floor(Math.random()*chars.length)
);

}

return name;

}


function getICCJPlayerName(){

// 1 — WordPress passed name

if(window.iccjBackgammonUser &&
window.iccjBackgammonUser.length>0){

return window.iccjBackgammonUser;

}


// 2 — Cookie

var cookieMatch=document.cookie.match(
/iccj_bg_name=([^;]+)/
);

if(cookieMatch){

return cookieMatch[1];

}


// 3 — generate random

var randomName=generateRandomName();

document.cookie=
"iccj_bg_name="+randomName+
"; path=/; max-age=31536000";

return randomName;

}


function App(){

this.init=function(config){

var username=getICCJPlayerName();

var client=new cl.Client({

serverURL:config.serverURL,

playerName:username

});


// auto-join

var params=new URLSearchParams(window.location.search);

var host=params.get('host');

if(host){

client.reqJoinMatchByHostSlug(host);

}


// invite button

$('#btn-challenge-friend').click(function(){

client.reqCreateMatchInviteOnly({

playerName:username,

hostSlug:username.toLowerCase()

},

function(msg,seq,reply){

if(!reply.result) return;

var inviteURL=

"https://www.iccj2004.org/backgammon/"
+username.toLowerCase();

$('#challenge-link').val(inviteURL);

});

});

};

}


var app=new App();

$(document).ready(function(){

new clipboard('.btn-copy');

var config=require('./config');

app.init(config);

});
