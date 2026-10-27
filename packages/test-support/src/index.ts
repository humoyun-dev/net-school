import selfsigned from 'selfsigned';

export interface TestCert {
  key: string;
  cert: string;
}

// Sinov uchun o'z-o'zidan imzolangan sertifikat (TLS tekshiruvi hech qachon o'chirilmaydi).
export async function makeCert(commonName = 'localhost'): Promise<TestCert> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: commonName }], {
    notAfterDate: new Date(Date.now() + 86_400_000),
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: commonName }] }],
  });
  return { key: pems.private, cert: pems.cert };
}

export const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await tick(5);
  }
}
