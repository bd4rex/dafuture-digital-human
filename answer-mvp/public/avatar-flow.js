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
    this.reason = 'ready';
    this.requestSequence = 0;
    this.speechSequence = 0;
  }

  announce(reason = 'ready') {
    this.reason = reason;
    this.onStateChange({ state: this.state, reason });
  }

  transition(state, reason) {
    if (!VALID_STATES.has(state)) {
      throw new Error(`Unknown avatar state: ${state}`);
    }

    this.state = state;
    this.reason = reason;
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
    this.transition('thinking', 'audio-preparing');
    return this.speechSequence;
  }

  startSpeech(speechSequence) {
    if (
      speechSequence !== this.speechSequence ||
      this.state !== 'thinking'
    ) {
      return false;
    }

    this.transition('speaking', 'audio-playing');
    return true;
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

  finishSpeech(speechSequence, outcome = 'completed') {
    if (speechSequence !== this.speechSequence) {
      return false;
    }

    this.transition('idle', outcome === 'completed' ? 'speech-finished' : `speech-${outcome}`);
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

/** Orders SSE and HTTP snapshots, including service restarts. Never replays audio. */
export class LiveStateTracker {
  constructor() {
    this.instanceId = null;
    this.sequence = -1;
    this.retiredInstances = new Set();
  }

  accept(snapshot) {
    if (!snapshot || typeof snapshot.instanceId !== 'string' ||
        !Number.isInteger(snapshot.sequence) || snapshot.sequence < 0 ||
        !['dialogue', 'hosting'].includes(snapshot.mode) ||
        !(snapshot.commandSequence === null ||
          (Number.isInteger(snapshot.commandSequence) && snapshot.commandSequence <= snapshot.sequence))) {
      return null;
    }
    if (this.retiredInstances.has(snapshot.instanceId)) return null;
    const restarted = this.instanceId !== null && this.instanceId !== snapshot.instanceId;
    if (this.instanceId === snapshot.instanceId && snapshot.sequence < this.sequence) return null;
    const duplicate = this.instanceId === snapshot.instanceId && snapshot.sequence === this.sequence;
    if (restarted) this.retiredInstances.add(this.instanceId);
    this.instanceId = snapshot.instanceId;
    this.sequence = snapshot.sequence;
    return { restarted, duplicate };
  }
}
