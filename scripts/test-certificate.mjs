// A throwaway self-signed code-signing certificate, for signing test installers:
// written as a .pfx into the folder given, and never left in a certificate store,
// so nothing trusts what it signs. Prints the settings for sign-windows.mjs.
//   node scripts/test-certificate.mjs <folder>
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function makeTestCertificate(folder) {
  mkdirSync(folder, { recursive: true });
  const pfx = resolve(join(folder, 'cashgear-test-signing.pfx'));
  const password = randomBytes(12).toString('hex');
  const script = [
    "$ErrorActionPreference = 'Stop';",
    'Import-Module Microsoft.PowerShell.Security, PKI;',
    "$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=CashGear Test Signing'",
    '-CertStoreLocation Cert:/CurrentUser/My -NotAfter (Get-Date).AddDays(30)',
    '-KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256;',
    `$secret = ConvertTo-SecureString -String '${password}' -Force -AsPlainText;`,
    `Export-PfxCertificate -Cert $cert -FilePath '${pfx}' -Password $secret | Out-Null;`,
    "Remove-Item -Path ('Cert:/CurrentUser/My/' + $cert.Thumbprint);",
    'Write-Output $cert.Thumbprint',
  ].join(' ');
  // Windows PowerShell started from PowerShell 7 (GitHub's runners) inherits
  // PSModulePath, then cannot load its own certificate commands: give it its own.
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  const thumbprint = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', env },
  ).trim();
  if (!/^[0-9A-F]{40}$/.test(thumbprint) || !existsSync(pfx)) {
    throw new Error(`The test certificate was not made: ${thumbprint}`);
  }
  return { pfx, password, thumbprint };
}

if (import.meta.main) {
  const folder = process.argv[2];
  if (!folder) throw new Error('Usage: node scripts/test-certificate.mjs <folder>');
  const { pfx, password, thumbprint } = makeTestCertificate(folder);
  console.log(`CGV_SIGN_PFX=${pfx}\nCGV_SIGN_PASSWORD=${password}\nThumbprint: ${thumbprint}`);
}
