# Work Order

Static web form for field work orders.

- Unlock with a passcode; reference data ships as an encrypted bundle (`docs/data.enc`,
  AES-256-GCM, key derived via PBKDF2-SHA256/600k) and is decrypted in the browser only.
- Fills the editable PDF template client-side; the tech downloads and emails it.
- Submissions are stored on the device (IndexedDB) with JSON export. Nothing is sent
  to any server.

`docs/` is the site root (GitHub Pages). Only ciphertext, the blank form template,
and app code are hosted.
