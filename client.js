// core modules
const fs = require('fs');
const http = require('http');
const https = require('https');
// modules installed from npm
const { EventEmitter } = require('events');
const express = require('express');
const bodyParser = require('body-parser');
const { createDecipher } = require('crypto');
require('dotenv').config();
const _ = require('lodash');
// application modules
const logger = require('./logger');
const {
  ivrVoiceCall, makeOutboundCall, hangupCall,bridgeCall,
} = require('./voiceapi');

// Express app setup
const app = express();
const eventEmitter = new EventEmitter();

var cluster = require('cluster');

let server;
let callVoiceId;
let retrycount = 0;
let ttsPlayVoice = 'female';
const sseMsg = [];
const servicePort = 3000;//process.argv[2];//process.env.SERVICE_PORT || 3000;

const numberArray = process.env.BRIDGETO.split(',');

console.log(`Number Array : ${numberArray}` );
// shutdown the node server forcefully
function shutdown() {
  server.close(() => {
    logger.error('Shutting down the server');
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 10000);
}

// Set webhook event url
function onListening() {
  console.log(`Listening on Port ${servicePort}`);
}

// Handle error generated while creating / starting an http server
function onError(error) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  switch (error.code) {
    case 'EACCES':
      logger.error(`Port ${servicePort} requires elevated privileges`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      logger.error(`Port ${servicePort} is already in use`);
      process.exit(1);
      break;
    default:
      throw error;
  }
}

// create and start an HTTPS node app server
// An SSL Certificate (Self Signed or Registered) is required
function createAppServer() {
  if (process.env.LISTEN_SSL !== 'false') {
    const options = {
      key: fs.readFileSync(process.env.CERTIFICATE_SSL_KEY).toString(),
      cert: fs.readFileSync(process.env.CERTIFICATE_SSL_CERT).toString(),
    };
    if (process.env.CERTIFICATE_SSL_CACERTS) {
      options.ca = [];
      options.ca.push(fs.readFileSync(process.env.CERTIFICATE_SSL_CACERTS).toString());
    }
    // Create https express server
    server = https.createServer(options, app);
  } else {
    // Create http express server
    server = http.createServer(app);
  }
  app.set('port', servicePort);
  server.listen(servicePort);
  server.on('error', onError);
  server.on('listening', onListening);
}

/* Initializing WebServer */
/*if (process.env.ENABLEX_APP_ID && process.env.ENABLEX_APP_KEY) {
  createAppServer();
} else {
  logger.error('Please set env variables - ENABLEX_APP_ID, ENABLEX_APP_KEY');
}

process.on('SIGINT', () => {
  console.log('Caught interrupt signal');
  shutdown();
});
*/
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('client'));

// outbound voice call
if (process.env.ENABLEX_APP_ID && process.env.ENABLEX_APP_KEY) {
  createAppServer();
} else {
  logger.error('Please set env variables - ENABLEX_APP_ID, ENABLEX_APP_KEY');
}

process.on('SIGINT', () => {
  console.log('Caught interrupt signal');
  shutdown();
});

let body = {
  "to" : process.env.TO,
  "from": process.env.FROM,
  "play_text" : process.env.TEXT,
  "play_voice": process.env.VOICE,
  "play_language" : process.env.LANGUAGE,
  "prompt_ref" : 'welcome_prompt'
} 

  /* Initiating Outbound Call */
makeOutboundCall(body, (response) => {
  const msg = JSON.parse(response);
  // set voice_id to be used throughout
  callVoiceId = msg.voice_id;
  console.log(`Voice Id of the Call ${callVoiceId}`);
});

// It will send stream / events all the events received from webhook to the client
app.get('/event-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const id = (new Date()).toLocaleTimeString();

  setInterval(() => {
    if (!_.isEmpty(sseMsg[0])) {
      const data = `${sseMsg[0]}`;
      res.write(`id: ${id}\n`);
      res.write(`data: ${data}\n\n`);
      sseMsg.pop();
    }
  }, 100);
});

// Webhook event which will be called by EnableX server once an outbound call is made
// It should be publicly accessible. Please refer document for webhook security.
app.post('/event', (req, res) => {
  let jsonObj;
  if (req.headers['x-algoritm'] !== undefined) {
    const key = createDecipher(req.headers['x-algoritm'], process.env.ENABLEX_APP_ID);
    let decryptedData = key.update(req.body.encrypted_data, req.headers['x-format'], req.headers['x-encoding']);
    decryptedData += key.final(req.headers['x-encoding']);
    jsonObj = JSON.parse(decryptedData);
    console.log('Response from webhook');
    console.log(JSON.stringify(jsonObj));
  } else {
    jsonObj = req.body;
    console.log(JSON.stringify(jsonObj));
  }

  res.send();
  res.status(200);
  eventEmitter.emit('voicestateevent', jsonObj);
});

// Call is completed / disconneted, inform server to hangup the call
function timeOutHandler(voice_id) {
  console.log(`[${voice_id}] Disconnecting the call`);
  hangupCall(voice_id, () => {});
}

/* WebHook Event Handler function */
function voiceEventHandler(voiceEvent) {
  console.log("Voice Event Received : " + JSON.stringify(voiceEvent));
  if (voiceEvent.state) {
    if (voiceEvent.state === 'connected') {
      const eventMsg = 'Outbound Call is connected';
      console.log(`[${callVoiceId}] ${eventMsg}`);
      sseMsg.push(eventMsg);
    } else if (voiceEvent.state === 'disconnected') {
      const eventMsg = 'Outbound Call is disconnected';
      console.log(`[${callVoiceId}] ${eventMsg}`);
      sseMsg.push(eventMsg);
    } else if (voiceEvent.state === 'bridged') {
      const eventMsg = 'Outbound Call is bridged';
      console.log(`[${callVoiceId}] ${eventMsg}`);
      sseMsg.push(eventMsg);
      setTimeout(timeOutHandler, 20000,voiceEvent.voice_id);	    
    } else if (voiceEvent.state === 'bridge_disconnected') {
      const eventMsg = 'Bridged Call is disconnected';
      console.log(`[${callVoiceId}] ${eventMsg}`);
      sseMsg.push(eventMsg);
    }
  }

  if (voiceEvent.playstate !== undefined) {
    if (voiceEvent.playstate === 'playfinished' && voiceEvent.prompt_ref === 'welcome_prompt') {
       console.log ("["+callVoiceId+"] Playing voice menu");
       ivrVoiceCall(voiceEvent.voice_id, ttsPlayVoice,'en-US', "Please press 1 to talk to sales team ... 2 to talk to service team ... 3 to disconnect the call", 'voice_menu',true, () => {});
    } else if (voiceEvent.playstate === 'menutimeout'){
       console.log ("["+callVoiceId+"]  menutimeout received");
    } else if(voiceEvent.playstate === 'digitcollected') {
      console.log ("["+callVoiceId+"] voice menu digit collected =>  " + voiceEvent.digit);
      const eventMsg = 'Received Digits : ' + voiceEvent.digit;
      logger.info(`[${callVoiceId}] ${eventMsg}`);
      dtmf_received = true;
      if(voiceEvent.digit === '1') {
        const eventMsg = 'Received Digits : ' + voiceEvent.digit + 'Your call will be forwarded to Sales Team';
        logger.info(`[${callVoiceId}] ${eventMsg}`);
        sseMsg.push(eventMsg);
        ivrVoiceCall(callVoiceId, 'en-US', ttsPlayVoice, "Your call will be forwarded to Sales Team", 'voice_menu', false, () => {});
        setTimeout(()=>{bridgeCall(callVoiceId, process.env.FROM , numberArray[voiceEvent.digit], () => {})},3000);
      } else if(voiceEvent.digit === '2') {
        const eventMsg = 'Received Digits : ' + voiceEvent.digit + ' Your call will be forwarded to Service Team';
        logger.info(`[${callVoiceId}] ${eventMsg}`);
        sseMsg.push(eventMsg);
        ivrVoiceCall(callVoiceId, ttsPlayVoice, 'en-US', "Your call will be forwarded to Service Team", 'voice_menu',false, () => {});
        setTimeout(()=>{bridgeCall(callVoiceId, process.env.FROM , numberArray[voiceEvent.digit], () => {})},3000);
      } else if(voiceEvent.digit === '3') {
        const eventMsg = 'Received Digits : ' + voiceEvent.digit + ' Your call will be disconnected';
        logger.info(`[${callVoiceId}] ${eventMsg}`);
        sseMsg.push(eventMsg);
        ivrVoiceCall(callVoiceId, ttsPlayVoice, 'en-US',"Thank you ! Have a nice day", 'voice_menu',false, () => {});
        setTimeout(timeOutHandler, 4000);
      } else {
        const eventMsg = 'Received Digits : ' + voiceEvent.digit + ' your have entered wrong digits';
        logger.info(`[${callVoiceId}] ${eventMsg}`);
        if(voiceEvent.digit.length > 0)
          sseMsg.push(eventMsg);
          dtmf_received = false;
          setTimeout(()=>{if(dtmf_received === false) ivrVoiceCall(callVoiceId, ttsPlayVoice,'en-US', "Sorry your have entered wrong digits", 'voice_menu', () => {});} , 1000);
      }
    } else if(voiceEvent.playstate && voiceEvent.playstate === 'initiated') {
      console.log ("["+callVoiceId+"] Play initiated, [play_id] " + voiceEvent.play_id);
    } else {
      console.log ("["+callVoiceId+"] Unknown event received");
    }
  }
}

/* Registering WebHook Event Handler function */
eventEmitter.on('voicestateevent', voiceEventHandler);
