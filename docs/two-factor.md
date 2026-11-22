# Dashboard two-factor sign-in

Optional. With it on, signing in to the dashboard needs the password **and** a 6-digit code
from an authenticator app.

- **Standard**: TOTP (RFC 6238) with SHA-1, 30-second steps and 6 digits, the defaults
  every authenticator app uses. The QR code is an `otpauth://totp/burrow:dashboard?...` URI
  with issuer `burrow`.
- **Set up** from **Sessions → Set up two-factor sign-in**. The key is shown once, as a QR code
  and as text. It isn't used until you confirm a code from the app, and a pending setup expires
  after 15 minutes. While two-factor is on, setup is refused, so no API returns the key again.
- **Codes**: the server accepts the current step plus one step either side, to allow for clock
  drift. A code (or an older one) can't be used again after a later code has been accepted. If
  a code is refused right after you signed in, wait for the next one.
- **Limits**: wrong codes at sign-in count toward the password rate limit (5 per 15 minutes per
  IP). Wrong codes in the Sessions panel (enable or turn off) have their own limit, with the
  same numbers.
- **Storage**: `~/.local/state/burrow/dashboard/totp.json`, mode 600, in a mode-700 directory.
  It holds the key and the last step used. It is not part of `burrow export`.
- **Turn off**: **Sessions → Turn off** with a current code, after a confirmation. This deletes
  the key. Setting it up again gives you a new key.
- **Lost the phone**: on the server, delete `~/.local/state/burrow/dashboard/totp.json`. Signing
  in then only needs the password. You can restart the dashboard (`burrow dashboard up`) as
  well, to end every session.
