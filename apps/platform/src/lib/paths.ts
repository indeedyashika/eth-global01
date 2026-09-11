export const TOKENIZATION_BASE_PATH = "";

export function withTokenizationBasePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`Expected an absolute application path, received "${path}"`);
  }
  if (path === TOKENIZATION_BASE_PATH || path.startsWith(`${TOKENIZATION_BASE_PATH}/`)) {
    return path;
  }
  return `${TOKENIZATION_BASE_PATH}${path}`;
}
