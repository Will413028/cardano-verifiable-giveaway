// A refusal with the HTTP status the route answers (apps/api/src/index.ts turns it into the response).
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
