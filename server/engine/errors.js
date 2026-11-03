// Engine errors carry a machine-readable code so the socket layer (Subtask 2)
// can forward precise invalid-action errors to clients.

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
