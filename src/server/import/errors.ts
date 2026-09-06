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

/** A profile provider (e.g. Apify) failed to return a usable profile. */
export class InstagramProviderError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "InstagramProviderError";
    this.status = options?.status;
  }
}
