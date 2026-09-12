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
  fullMsg: $('full-msg'),
  toast: $('toast'),
  remoteVideo: $('remote-video'),
  remotePlaceholder: $('remote-placeholder'),
  localVideo: $('local-video'),
  localPlaceholder: $('local-placeholder'),
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
  socket.on('chat', onChat);
  socket.on('user-left', onUserLeft);
  socket.on('room-full', () => toast('This meeting link is full. Only 2 people can join.'));
  socket.on('error-msg', ({ message }) => toast(message));
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

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
  } catch (err) {
    toast('Camera or microphone access was blocked. Allow access and try again.');
    return;
  }

  els.localVideo.srcObject = localStream;
  els.lobby.hidden = true;
  els.call.hidden = false;

  const fullLink = url.origin + url.pathname + '?room=' + encodeURIComponent(roomId);
  els.link.textContent = fullLink;
  els.link.href = fullLink;

  socket.emit('join-room', { roomId, username });
}

function onJoined({ users, isInitiator }) {
  const peer = users.find((u) => u.id !== socket.id);
  if (peer) {
    peerId = peer.id;
    if (isInitiator) startCall();
  } else {
    setStatus('Waiting for the other person to join with the link\u2026');
  }
}

function onUserJoined({ userId }) {
  peerId = userId;
  setStatus('Connecting\u2026');
}

function startCall() {
  pc = createPeer();
  setStatus('Connecting\u2026');
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
    els.remoteVideo.srcObject = e.streams[0];
    els.remotePlaceholder.hidden = true;
  };

  p.onconnectionstatechange = () => {
    if (p.connectionState === 'connected') setStatus('');
    else if (p.connectionState === 'failed') setStatus('Connection failed');
    else if (p.connectionState === 'disconnected') setStatus('Reconnecting\u2026');
  };

  return p;
}

async function onSignal({ from, data }) {
  if (from !== peerId) return;

  if (data.type === 'offer') {
    if (!pc) pc = createPeer();
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ type: 'answer', sdp: pc.localDescription });
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription(data.sdp);
  } else if (data.type === 'candidate') {
    if (pc && pc.remoteDescription) await pc.addIceCandidate(data.candidate);
  }
}

function sendSignal(data) {
  if (!peerId) return;
  socket.emit('signal', { to: peerId, data });
}

function onUserLeft() {
  tearDownPeer();
  setStatus('Waiting for the other person to join with the link\u2026');
}

function tearDownPeer() {
  if (pc) { pc.close(); pc = null; }
  stopScreenShare();
  peerId = null;
  els.remoteVideo.srcObject = null;
  els.remotePlaceholder.hidden = false;
  els.remotePlaceholder.textContent = 'Waiting for the other person to join with the link\u2026';
  els.localVideo.hidden = false;
}

function toggleMic() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.micBtn.classList.toggle('off', !track.enabled);
  els.micLabel.textContent = track.enabled ? 'Mute' : 'Unmute';
}

function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.camBtn.classList.toggle('off', !track.enabled);
  els.camLabel.textContent = track.enabled ? 'Camera' : 'Camera on';
  els.localPlaceholder.hidden = track.enabled;
}

async function toggleScreen() {
  const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');

  if (displayStream) {
    stopScreenShare();
    return;
  }

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = displayStream.getVideoTracks()[0];
    screenTrack.onended = stopScreenShare;
    if (sender) await sender.replaceTrack(screenTrack);
    els.screenBtn.classList.add('active');
    els.screenLabel.textContent = 'Stop sharing';
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
    if (sender && camTrack) sender.replaceTrack(camTrack);
  }
  els.screenBtn.classList.remove('active');
  els.screenLabel.textContent = 'Share screen';
}

function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text || !peerId) return;
  addChatMessage('You', text, true);
  socket.emit('chat', { to: peerId, text });
  els.chatInput.value = '';
  els.chatWelcome.hidden = true;
}

function onChat({ fromName, text }) {
  addChatMessage(fromName, text, false);
  els.chatWelcome.hidden = true;
  if (!els.chat.classList.contains('open')) els.chat.classList.add('open');
}

function addChatMessage(name, text, mine) {
  const div = document.createElement('div');
  div.className = 'msg' + (mine ? ' mine' : '');
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = name;
  const textEl = document.createElement('span');
  textEl.className = 'text';
  textEl.textContent = text;
  div.appendChild(nameEl);
  div.appendChild(textEl);
  els.chatMessages.appendChild(div);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function copyLink() {
  navigator.clipboard.writeText(els.link.textContent).then(() => {
    const prev = els.copyBtn.textContent;
    els.copyBtn.textContent = 'Copied!';
    setTimeout(() => { els.copyBtn.textContent = prev; }, 1500);
  }).catch(() => toast('Could not copy the link.'));
}

function leave() {
  socket.disconnect();
  tearDownPeer();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  els.call.hidden = true;
  els.landing.hidden = false;
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