//! OS-vault credential persistence for the SFTP save source (wave 2, opt-in).
//!
//! When the user ticks "Remember password" in the connect modal, the connection
//! secret (password and/or key passphrase) is stored in the operating system's
//! credential vault — Windows Credential Manager via the `keyring` crate — and
//! NEVER in a file, in `localStorage`, or under a homebrew cipher. The non-secret
//! [`crate::sftp::SftpProfile`] still lives in `localStorage` (with a `remember`
//! flag); only the secret material crosses into the vault here.
//!
//! Vault key (pinned cross-slice contract):
//!   - service: `"pal-lab.sftp"`
//!   - account: `"<host>:<port>:<user>"`
//!   - value:   JSON `{"password": string|null, "key_passphrase": string|null}`
//!
//! Commands ([`sftp_secret_store`], [`sftp_secret_load`], [`sftp_secret_forget`])
//! are registered in `lib.rs`. A missing entry is NEVER an error: load returns
//! `None`, forget succeeds silently.

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

use crate::sftp::SftpProfile;

/// Keyring service name — the fixed namespace for every Pal Lab SFTP secret.
const VAULT_SERVICE: &str = "pal-lab.sftp";

/// The secret material persisted per endpoint. Serde shape matches the TS
/// `SftpSecret` (and Rust `crate::sftp::SftpSecret`), so it doubles as both the
/// stored JSON value and the `sftp_secret_load` return payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredSecret {
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
}

/// Build the vault account key `"<host>:<port>:<user>"` for a profile. This is
/// the per-endpoint identity; changing host, port, or user targets a different
/// stored secret (correct — they are different logins).
fn account(profile: &SftpProfile) -> String {
    format!("{}:{}:{}", profile.host, profile.port, profile.user)
}

/// Open the keyring [`Entry`] for a profile's endpoint.
fn entry(profile: &SftpProfile) -> Result<Entry, String> {
    Entry::new(VAULT_SERVICE, &account(profile))
        .map_err(|e| format!("Couldn't open the OS credential vault: {e}"))
}

/// Store (or overwrite) the secret for `profile`'s endpoint in the OS vault.
#[tauri::command]
pub fn sftp_secret_store(profile: SftpProfile, secret: StoredSecret) -> Result<(), String> {
    let json = serde_json::to_string(&secret)
        .map_err(|e| format!("Couldn't encode the credential: {e}"))?;
    entry(&profile)?
        .set_password(&json)
        .map_err(|e| format!("Couldn't save the credential to the OS vault: {e}"))
}

/// Load the stored secret for `profile`'s endpoint. A missing entry is `None`,
/// NOT an error (nothing was ever remembered for this endpoint).
#[tauri::command]
pub fn sftp_secret_load(profile: SftpProfile) -> Result<Option<StoredSecret>, String> {
    match entry(&profile)?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| format!("The stored credential is corrupt: {e}")),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("Couldn't read the credential from the OS vault: {e}")),
    }
}

/// Delete the stored secret for `profile`'s endpoint. Tolerant of a missing
/// entry (already forgotten / never stored) — that is success, not an error.
#[tauri::command]
pub fn sftp_secret_forget(profile: SftpProfile) -> Result<(), String> {
    match entry(&profile)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("Couldn't remove the credential from the OS vault: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> SftpProfile {
        SftpProfile {
            host: "server.example.com".into(),
            port: 2222,
            user: "steam".into(),
            auth: "password".into(),
            key_path: None,
            root: "/home/steam/Pal/Saved/SaveGames".into(),
            remember: true,
        }
    }

    #[test]
    fn account_key_is_host_port_user() {
        assert_eq!(account(&profile()), "server.example.com:2222:steam");
    }

    #[test]
    fn stored_secret_json_round_trips() {
        let secret = StoredSecret {
            password: Some("hunter2".into()),
            key_passphrase: None,
        };
        let json = serde_json::to_string(&secret).unwrap();
        // Field names must match the pinned contract exactly.
        assert_eq!(json, r#"{"password":"hunter2","key_passphrase":null}"#);
        let back: StoredSecret = serde_json::from_str(&json).unwrap();
        assert_eq!(back, secret);
    }

    #[test]
    fn stored_secret_round_trips_passphrase_only() {
        let secret = StoredSecret {
            password: None,
            key_passphrase: Some("s3cret".into()),
        };
        let back: StoredSecret =
            serde_json::from_str(&serde_json::to_string(&secret).unwrap()).unwrap();
        assert_eq!(back, secret);
    }

    /// Real end-to-end vault round-trip against the live OS credential store.
    /// `#[ignore]` so the default `cargo test` run never touches the real
    /// Windows Credential Manager; run explicitly with
    /// `cargo test -- --ignored sftp_vault` to exercise it. Cleans up after
    /// itself, and asserts the missing-entry-is-None / forget-is-idempotent
    /// contract.
    #[test]
    #[ignore = "hits the real OS credential vault; run with --ignored"]
    fn real_vault_store_load_forget() {
        let mut p = profile();
        // Isolate from any real user secret by using a throwaway account.
        p.user = "pal-lab-test-throwaway".into();

        // Clean slate.
        sftp_secret_forget(p.clone()).unwrap();
        assert_eq!(sftp_secret_load(p.clone()).unwrap(), None);

        let secret = StoredSecret {
            password: Some("pw".into()),
            key_passphrase: Some("pp".into()),
        };
        sftp_secret_store(p.clone(), secret.clone()).unwrap();
        assert_eq!(sftp_secret_load(p.clone()).unwrap(), Some(secret));

        // Forget removes it; a second forget is still Ok (missing == success).
        sftp_secret_forget(p.clone()).unwrap();
        assert_eq!(sftp_secret_load(p.clone()).unwrap(), None);
        sftp_secret_forget(p.clone()).unwrap();
    }
}
