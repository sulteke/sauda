/** The discovery seed input is not a usable profile or hashtag. */
export class DiscoveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryValidationError";
  }
}

/** A discovery source failed (network, timeout, non-2xx, bad payload, config). */
export class DiscoveryProviderError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DiscoveryProviderError";
    this.status = options?.status;
  }
}

/** The seed profile does not exist (e.g. deleted account). */
export class DiscoveryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryNotFoundError";
  }
}

/** The seed profile is private, so nothing could be discovered from it. */
export class DiscoveryPrivateAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryPrivateAccountError";
  }
}
