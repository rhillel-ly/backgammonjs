'use strict';

var $ = require('jquery');
var clipboard = require('clipboard');
var cl = require('../../../lib/client');
var comm = require('../../../lib/comm.js');

function generateRandomName(){

var chars='abcdefghijklmnopqrstuvwxyz0123456789';

var name='player_';

for(var i=0;i<8;i++){

name+=chars.charAt(
Math.floor(Math.random()*chars.length)
);

}

return name;

}


function getICCJPlayerName(){

if(window.iccjBackgammonUser &&
window.iccjBackgammonUser.length>0){

return window.iccjBackgammonUser;

}

var cookieMatch=document.cookie.match(
/iccj_bg_name=([^;]+)/
);

if(cookieMatch){

return cookieMatch[1];

}

var randomName=generateRandomName();

document.cookie=
"iccj_bg_name="+randomName+
"; path=/; max-age=31536000";

return randomName;

}



function App(){

this.init=function(config){

var username=getICCJPlayerName();

var client=new cl.Client(config);


client.subscribe(comm.Message.CREATE_GUEST,function(msg,params){

if(params.player){

params.player.name=username;

}

});


client.subscribe(comm.Message.CREATE_MATCH,function(msg,params){

if(!params.result) return;

var hostSlug=username
.toLowerCase()
.replace(/[^a-z0-9]+/g,'-')
.replace(/^-+|-+$/g,'');


var inviteURL=
"https://www.iccj2004.org/backgammon/?host="
+encodeURIComponent(hostSlug);


$('#challenge-link').val(inviteURL);

$('#challenge-link').show();

});


client.subscribe(comm.Message.EVENT_MATCH_START,function(){

$('#index-view').hide();

$('#game-view').show();

});


$('#btn-challenge-friend').off().on('click',function(){

client.reqCreateMatch("RuleBgCasual");

});


var params=new URLSearchParams(window.location.search);

var host=params.get('host');

if(host){

client.reqJoinMatch(host);

}


// REMOVE unwanted UI


$('#btn-play-random').remove();

$('#rule-selector').remove();


};

}



var app=new App();


$(document).ready(function(){

new clipboard('.btn-copy');

var config=require('./config');

app.init(config);

});
