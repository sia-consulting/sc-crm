import { AccessToken } from '@azure/identity';

export const extractUsernameFromToken = (
  accessToken?: AccessToken,
  type: 'oid' | 'upn' = 'oid',
): string | undefined => {
  if (!accessToken?.token) {
    return undefined;
  }
  const base64Metadata = accessToken.token.split('.')[1];
  const result = JSON.parse(
    Buffer.from(base64Metadata, 'base64').toString('utf8'),
  );

  return result[type];
};
