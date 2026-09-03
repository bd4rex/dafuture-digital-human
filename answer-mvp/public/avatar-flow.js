export const AVATAR_STATES = Object.freeze([
  'idle',
  'thinking',
  'speaking',
  'presenting',
]);

const VALID_STATES = new Set(AVATAR_STATES);

/**
 * Keeps network and speech callbacks from moving the avatar backwards after a
 * newer interaction has already started.
 */
export class AvatarFlow {
  constructor(onStateChange = () => {}) {
    this.onStateChange = onStateChange;
    this.state = 'idle';
    this.requestSequence = 0;
    this.speechSequence = 0;
  }

  announce(reason = 'ready') {
    this.onStateChange({ state: this.state, reason });
  }

  transition(state, reason) {
    if (!VALID_STATES.has(state)) {
      throw new Error(`Unknown avatar state: ${state}`);
    }

    this.state = state;
    this.onStateChange({ state, reason });
  }

  beginQuestion() {
    this.requestSequence += 1;
    this.speechSequence += 1;
    this.transition('thinking', 'question-started');
    return this.requestSequence;
  }

  answerReady(requestSequence) {
    if (requestSequence !== this.requestSequence || this.state !== 'thinking') {
      return null;
    }

    this.speechSequence += 1;
    this.transition('speaking', 'answer-ready');
    return this.speechSequence;
  }

  failQuestion(requestSequence) {
    if (requestSequence !== this.requestSequence) {
      return false;
    }

    this.speechSequence += 1;
    this.transition('idle', 'question-failed');
    return true;
  }

  beginPresentation() {
    this.requestSequence += 1;
    this.speechSequence += 1;
    this.transition('presenting', 'presentation-started');
    return this.speechSequence;
  }

  finishSpeech(speechSequence) {
    if (speechSequence !== this.speechSequence) {
      return false;
    }

    this.transition('idle', 'speech-finished');
    return true;
  }

  preview(state) {
    this.requestSequence += 1;
    this.speechSequence += 1;
    this.transition(state, 'manual-preview');
    return this.speechSequence;
  }

  reset(reason = 'reset') {
    this.requestSequence += 1;
    this.speechSequence += 1;
    this.transition('idle', reason);
  }
}
