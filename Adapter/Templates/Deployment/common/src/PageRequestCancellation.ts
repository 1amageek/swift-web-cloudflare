export class PageRequestCancellationError extends Error {
  constructor() {
    super("Page request was cancelled");
    this.name = "PageRequestCancellationError";
  }
}
