import { signJwt, type JwtClaims, type KeySet } from "./jwt";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

function pem(label: string, der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join("\n");
}

/** The PKCS#1 key inside a PKCS#8 PrivateKeyInfo: its trailing OCTET STRING. */
function pkcs8ToPkcs1(pkcs8: Uint8Array): Uint8Array {
  let offset = pkcs8[1] & 0x80 ? 2 + (pkcs8[1] & 0x7f) : 2; // outer SEQUENCE
  offset += 3; // version
  offset += 2 + pkcs8[offset + 1]; // AlgorithmIdentifier
  const lengthByte = pkcs8[offset + 1];
  const lengthBytes = lengthByte & 0x80 ? lengthByte & 0x7f : 0;
  return pkcs8.slice(offset + 2 + lengthBytes);
}

/**
 * An RSA key pair standing in for an issuer (Access, GitHub OIDC) or the
 * GitHub App: signs tokens, and publishes its public key as a KeySet.
 */
export async function testSigner(kid = "test-key") {
  const pair = (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const keys: KeySet = { key: async (id) => (id === kid ? pair.publicKey : undefined) };

  return {
    sign: (claims: JwtClaims) => signJwt(claims, pair.privateKey, kid),
    keys,
    publicKey: pair.publicKey,
    pkcs8Pem: pem("PRIVATE KEY", pkcs8),
    pkcs1Pem: pem("RSA PRIVATE KEY", pkcs8ToPkcs1(pkcs8)),
  };
}
