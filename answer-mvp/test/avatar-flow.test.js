import assert from 'node:assert/strict';
import test from 'node:test';

import { AvatarFlow, AVATAR_STATES } from '../public/avatar-flow.js';

test('数字人状态完整覆盖待机、思考、对话和主持', () => {
  assert.deepEqual(AVATAR_STATES, [
    'idle',
    'thinking',
    'speaking',
    'presenting',
  ]);
});

test('问答按思考、说话、待机的时序流转', () => {
  const states = [];
  const flow = new AvatarFlow(({ state }) => states.push(state));

  flow.announce();
  const requestSequence = flow.beginQuestion();
  const speechSequence = flow.answerReady(requestSequence);

  assert.ok(Number.isInteger(speechSequence));
  assert.equal(flow.finishSpeech(speechSequence), true);
  assert.deepEqual(states, ['idle', 'thinking', 'speaking', 'idle']);
});

test('旧请求和旧语音回调不会覆盖新交互状态', () => {
  const flow = new AvatarFlow();
  const firstRequest = flow.beginQuestion();
  const secondRequest = flow.beginQuestion();

  assert.equal(flow.answerReady(firstRequest), null);
  const activeSpeech = flow.answerReady(secondRequest);
  const presentationSpeech = flow.beginPresentation();

  assert.equal(flow.finishSpeech(activeSpeech), false);
  assert.equal(flow.state, 'presenting');
  assert.equal(flow.finishSpeech(presentationSpeech), true);
  assert.equal(flow.state, 'idle');
});

test('手动预览姿态后可确定性恢复待机', () => {
  const flow = new AvatarFlow();
  flow.preview('thinking');
  assert.equal(flow.state, 'thinking');
  flow.reset('preview-finished');
  assert.equal(flow.state, 'idle');
});
