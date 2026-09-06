/** The discovery seed input is not a usable profile or hashtag. */
export class DiscoveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryValidationError";
  }
}
