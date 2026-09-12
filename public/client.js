'use strict';

const socket = io();

const url = new URL(window.location.href);
let roomId = url.searchParams.get('room') || '';
let username = localStorage.getItem('vc-name') || 'Guest-' + Math.random().toString(36).slice(2, 7);

const $ = (id) => document.getElementById(id);

const els = {
  landing: $('landing'),
  createBtn: $('create-btn'),
  lobby: $('lobby'),
  roomLabel: $('room-label'),
  nameInput: $('name-input'),
  joinBtn: $('join-btn'),
  call: $('call'),
  link: $('link'),
  copyBtn: $('copy-btn'),
  status: $('status'),
  toast: $('toast'),
  remoteVideo: $('remote-video'),
  remotePlaceholder: $('remote-placeholder'),
  remoteName: $('remote-name'),
  remoteMic: $('remote-mic'),
  remoteCam: $('remote-cam'),
  remoteScreen: $('remote-screen'),
  localVideo: $('local-video'),
  localPlaceholder: $('local-placeholder'),
  localName: $('local-name'),
  localScreen: $('local-screen'),
  micBtn: $('mic-btn'),
  micLabel: $('mic-label'),
  camBtn: $('cam-btn'),
  camLabel: $('cam-label'),
  screenBtn: $('screen-btn'),
  screenLabel: $('screen-label'),
  leaveBtn: $('leave-btn'),
  chat: $('chat'),
  chatClose: $('chat-close'),
  chatWelcome: $('chat-welcome'),
  chatMessages: $('chat-messages'),
  chatInput: $('chat-input'),
  chatSend: $('chat-send'),
};

let localStream = null;
let displayStream = null;
let pc = null;
let peerId = null;
let peerName = '';
let myMicOn = true;
let myVideoState = 'on'; // 'on' | 'off' | 'screen'
let rejoinTimer = null;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

init();

function init() {
  els.nameInput.value = username;

  if (roomId) showLobby();

  els.createBtn.addEventListener('click', () => {
    roomId = makeId();
    url.searchParams.set('room', roomId);
    history.replaceState({}, '', url);
    showLobby();
  });

  els.joinBtn.addEventListener('click', joinCall);
  els.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinCall(); });
  els.copyBtn.addEventListener('click', copyLink);
  els.micBtn.addEventListener('click', toggleMic);
  els.camBtn.addEventListener('click', toggleCam);
  els.screenBtn.addEventListener('click', toggleScreen);
  els.chatBtn.addEventListener('click', () => els.chat.classList.add('open'));
  els.chatClose.addEventListener('click', () => els.chat.classList.remove('open'));
  els.leaveBtn.addEventListener('click', leave);
  els.chatSend.addEventListener('click', sendChat);
  els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  socket.on('joined', onJoined);
  socket.on('user-joined', onUserJoined);
  socket.on('signal', onSignal);
  socket.on('peer-state', onPeerState);
  socket.on('chat', onChat);
  socket.on('user-left', onUserLeft);
  socket.on('room-full', onRoomFull);
  socket.on('error-msg', ({ message }) => toast(message));
  socket.on('connect', onSocketReconnect);
}

function onSocketReconnect() {
  // After a network blip or server restart the socket gets a new id and the
  // server room state is gone. If we were mid-call, rebuild it.
  if (els.call.hidden || !roomId) return;
  if (pc) tearDownPeer();
  setStatus('Reconnecting\u2026');
  socket.emit('join-room', { roomId, username });
}

function showLobby() {
  els.landing.hidden = true;
  els.lobby.hidden = false;
  els.roomLabel.textContent = 'Meeting link contains room "' + roomId + '".';
  els.nameInput.focus();
}

async function joinCall() {
  username = els.nameInput.value.trim() || username;
  localStorage.setItem('vc-name', username);

  localStream = await acquireMedia();
  if (!localStream) {
    toast('Microphone access was blocked. Allow access and try again.');
    return;
  }

  els.localVideo.srcObject = localStream;
  els.localName.textContent = username;
  els.lobby.hidden = true;
  els.call.hidden = false;

  if (!localStream.getVideoTracks()[0]) {
    myVideoState = 'off';
    els.localPlaceholder.hidden = false;
    els.localPlaceholder.textContent = 'No camera';
    els.camBtn.disabled = true;
    els.camBtn.classList.add('off');
    els.camLabel.textContent = 'No camera';
    els.screenBtn.disabled = true;
  }

  const fullLink = url.origin + url.pathname + '?room=' + encodeURIComponent(roomId);
  els.link.textContent = fullLink;
  els.link.href = fullLink;

  socket.emit('join-room', { roomId, username });
}

async function acquireMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
  } catch (err) {
    // Camera missing or blocked: retry with audio only.
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err2) {
      return null;
    }
  }
}

function onJoined({ users, isInitiator }) {
  clearRejoin();
  const peer = users.find((u) => u.id !== socket.id);
  if (peer) {
    peerId = peer.id;
    peerName = peer.name;
    els.remoteName.textContent = peerName;
    sendPeerState();
    if (isInitiator) startCall();
  } else {
    setStatus('Waiting for the other person to join with the link\u2026');
  }
}

function onUserJoined({ userId, username: name }) {
  peerId = userId;
  peerName = name || 'Guest';
  els.remoteName.textContent = peerName;
  sendPeerState();
  showConnecting();
}

function onRoomFull() {
  setStatus('Meeting is full \u2014 waiting for a spot\u2026');
  els.remotePlaceholder.hidden = false;
  els.remotePlaceholder.textContent = 'This meeting is full (2 people max). Waiting for a spot\u2026';
  startRejoin();
}

function startRejoin() {
  if (rejoinTimer) return;
  rejoinTimer = setInterval(() => {
    socket.emit('join-room', { roomId, username });
  }, 2500);
}

function clearRejoin() {
  if (rejoinTimer) {
    clearInterval(rejoinTimer);
    rejoinTimer = null;
  }
}

function startCall() {
  if (pc) return;
  pc = createPeer();
  showConnecting();
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => sendSignal({ type: 'offer', sdp: pc.localDescription }))
    .catch(() => toast('Could not start the call.'));
}

function createPeer() {
  const p = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach((t) => p.addTrack(t, localStream));

  p.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ type: 'candidate', candidate });
  };

  p.ontrack = (e) => {
    if (e.streams[0]) els.remoteVideo.srcObject = e.streams[0];
    if (!els.remoteVideo.hidden) els.remotePlaceholder.hidden = true;
  };

  p.onconnectionstatechange = () => {
    const s = p.connectionState;
    if (s === 'connected') setStatus('');
    else if (s === 'failed') setStatus('Connection failed');
    else if (s === 'disconnected') setStatus('Reconnecting\u2026');
    else if (s === 'connecting') showConnecting();
  };

  return p;
}

async function onSignal({ from, data }) {
  if (from !== peerId) return;
  try {
    if (data.type === 'offer') {
      if (!pc) pc = createPeer();
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: pc.localDescription });
      sendPeerState();
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(data.sdp);
      sendPeerState();
    } else if (data.type === 'candidate') {
      if (pc && pc.remoteDescription) await pc.addIceCandidate(data.candidate);
    }
  } catch (err) {
    // Ignore races (e.g. the peer left mid-negotiation).
  }
}

function sendSignal(data) {
  if (!peerId) return;
  socket.emit('signal', { to: peerId, data });
}

function showConnecting() {
  setStatus('Connecting\u2026');
  if (!els.remoteVideo.hidden) {
    els.remotePlaceholder.hidden = false;
    els.remotePlaceholder.textContent = 'Connecting\u2026';
  }
}

function onUserLeft() {
  tearDownPeer();
  setStatus('Waiting for the other person to join with the link\u2026');
}

function tearDownPeer() {
  if (pc) { pc.close(); pc = null; }
  stopScreenShare();
  peerId = null;
  peerName = '';
  els.remoteVideo.srcObject = null;
  els.remoteVideo.hidden = false;
  els.remotePlaceholder.hidden = false;
  els.remotePlaceholder.textContent = 'Waiting for the other person to join with the link\u2026';
  els.remoteName.textContent = '';
  els.remoteMic.hidden = true;
  els.remoteCam.hidden = true;
  els.remoteScreen.hidden = true;
}

function toggleMic() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  myMicOn = !track.enabled;
  track.enabled = myMicOn;
  els.micBtn.classList.toggle('off', !myMicOn);
  els.micLabel.textContent = myMicOn ? 'Mute' : 'Unmute';
  sendPeerState();
}

function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.camBtn.classList.toggle('off', !track.enabled);
  els.camLabel.textContent = track.enabled ? 'Camera' : 'Camera on';
  els.localPlaceholder.hidden = track.enabled;
  if (myVideoState === 'screen') return; // camera isn't transmitted while sharing
  myVideoState = track.enabled ? 'on' : 'off';
  sendPeerState();
}

async function toggleScreen() {
  if (!pc) {
    toast('Wait until the other person joins before sharing your screen.');
    return;
  }
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (!sender) {
    toast('No video track is available to share.');
    return;
  }

  if (displayStream) {
    stopScreenShare();
    return;
  }

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = displayStream.getVideoTracks()[0];
    screenTrack.onended = stopScreenShare;
    await sender.replaceTrack(screenTrack);
    myVideoState = 'screen';
    els.screenBtn.classList.add('active');
    els.screenLabel.textContent = 'Stop sharing';
    els.localScreen.hidden = false;
    sendPeerState();
  } catch (err) {
    toast('Screen sharing was cancelled or unavailable.');
  }
}

function stopScreenShare() {
  if (displayStream) {
    displayStream.getTracks().forEach((t) => t.stop());
    displayStream = null;
    const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    const camTrack = localStream && localStream.getVideoTracks()[0];
    if (sender) {
      if (camTrack) sender.replaceTrack(camTrack).catch(() => {});
      else sender.replaceTrack(null).catch(() => {});
    }
  }
  if (myVideoState === 'screen') {
    myVideoState = localStream && localStream.getVideoTracks()[0] ? 'on' : 'off';
  }
  els.screenBtn.classList.remove('active');
  els.screenLabel.textContent = 'Share screen';
  els.localScreen.hidden = true;
  sendPeerState();
}

function myState() {
  return { audio: myMicOn, video: myVideoState, name: username };
}

function sendPeerState() {
  if (!peerId) return;
  socket.emit('peer-state', { to: peerId, data: myState() });
}

function onPeerState({ from, data }) {
  if (from !== peerId) return;
  const name = data.name || peerName || 'Guest';
  els.remoteName.textContent = name;
  els.remoteMic.hidden = !!data.audio;
  if (data.video === 'off') {
    els.remoteVideo.hidden = true;
    els.remotePlaceholder.hidden = false;
    els.remotePlaceholder.textContent = name + "'s camera is off";
    els.remoteCam.hidden = false;
    els.remoteScreen.hidden = true;
  } else {
    els.remoteVideo.hidden = false;
    els.remoteCam.hidden = true;
    els.remoteScreen.hidden = data.video !== 'screen';
    if (pc && pc.connectionState === 'connected') els.remotePlaceholder.hidden = true;
  }
}

function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text || !peerId) return;
  addChatMessage('You', text, true);
  socket.emit('chat', { to: peerId, text });
  els.chatInput.value = '';
  els.chatWelcome.hidden = true;
}

function onChat({ fromName, text, time }) {
  addChatMessage(fromName, text, false, time);
  els.chatWelcome.hidden = true;
  if (!els.chat.classList.contains('open')) els.chat.classList.add('open');
}

function addChatMessage(name, text, mine, time) {
  const div = document.createElement('div');
  div.className = 'msg' + (mine ? ' mine' : '');

  const head = document.createElement('span');
  head.className = 'msg-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = name;
  const timeEl = document.createElement('span');
  timeEl.className = 'time';
  timeEl.textContent = time ? fmtTime(time) : fmtTime();
  head.appendChild(nameEl);
  head.appendChild(timeEl);

  const textEl = document.createElement('span');
  textEl.className = 'text';
  textEl.textContent = text;

  div.appendChild(head);
  div.appendChild(textEl);
  els.chatMessages.appendChild(div);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function fmtTime(t) {
  const d = new Date(t || Date.now());
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function copyLink() {
  const text = els.link.textContent;
  const done = () => {
    els.copyBtn.textContent = 'Copied!';
    setTimeout(() => { els.copyBtn.textContent = 'Copy link'; }, 1500);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (e) {
    toast('Could not copy the link.');
  }
  document.body.removeChild(ta);
}

function leave() {
  clearRejoin();
  if (pc) { pc.close(); pc = null; }
  stopScreenShare();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  window.location.href = url.origin + url.pathname;
}

function setStatus(text) {
  els.status.textContent = text;
}

function makeId() {
  return 'call-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4000);
}