/** The pasted URL is not a usable Instagram profile URL. */
export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

/** The import job is not in a state that allows the requested transition. */
export class ImportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportStateError";
  }
}
