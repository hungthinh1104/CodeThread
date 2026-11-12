type ViewerFailureCode =
  | 'INVALID_FACTS'
  | 'SOURCE_UNAVAILABLE'
  | 'HASH_MISMATCH'
  | 'SNAPSHOT_NOT_FOUND'
  | 'ENTITY_NOT_FOUND'
  | 'RESOURCE_LIMIT'
  | 'INVALID_REQUEST'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL_ERROR';

export class ViewerFailure extends Error {
  readonly code: ViewerFailureCode;
  readonly status: number;

  constructor(code: ViewerFailureCode, message: string, status: number) {
    super(message);
    this.name = 'ViewerFailure';
    this.code = code;
    this.status = status;
  }
}
