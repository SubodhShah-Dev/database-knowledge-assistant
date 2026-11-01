import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError, changePassword, getUserProfile, updateUserProfile } from '../api/client';
import type { PasswordChange, ProfileUpdate } from '../types';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconKey,
  IconLock,
  IconRefresh
} from '../components/icons';

export default function SettingsPage() {
  const { user, refreshUser, updateUser } = useAuth();
  const [profileForm, setProfileForm] = useState<ProfileUpdate>({
    first_name: user?.first_name ?? '',
    last_name: user?.last_name ?? ''
  });
  const [passwordForm, setPasswordForm] = useState<PasswordChange>({
    current_password: '',
    new_password: '',
    confirm_password: ''
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileNotice, setProfileNotice] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordNotice, setPasswordNotice] = useState('');

  useEffect(() => {
    setProfileForm({
      first_name: user?.first_name ?? '',
      last_name: user?.last_name ?? ''
    });
  }, [user]);

  async function handleProfileSave(event: FormEvent) {
    event.preventDefault();
    setProfileSaving(true);
    setProfileError('');
    setProfileNotice('');
    try {
      const data = {
        first_name: profileForm.first_name?.trim() || null,
        last_name: profileForm.last_name?.trim() || null
      };
      const updated = await updateUserProfile(data);
      updateUser({ first_name: updated.first_name, last_name: updated.last_name });
      setProfileNotice('Profile updated successfully.');
    } catch (err) {
      setProfileError(err instanceof ApiError ? err.message : 'Could not update profile.');
    } finally {
      setProfileSaving(false);
    }
  }

  async function handlePasswordChange(event: FormEvent) {
    event.preventDefault();
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordError('New passwords do not match.');
      return;
    }
    if (passwordForm.new_password.length < 8) {
      setPasswordError('New password must be at least 8 characters.');
      return;
    }
    setPasswordSaving(true);
    setPasswordError('');
    setPasswordNotice('');
    try {
      await changePassword(passwordForm);
      setPasswordNotice('Password changed successfully.');
      setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
    } catch (err) {
      setPasswordError(err instanceof ApiError ? err.message : 'Could not change password.');
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Profile & Security</h1>
          <p>Manage your profile information and password.</p>
        </div>
      </div>

      <div className="admin-model-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Profile</h2>
              <p>Your name appears in the account menu and chat sessions.</p>
            </div>
          </div>

          <form className="form-stack" onSubmit={handleProfileSave}>
            {profileError && (
              <div className="alert alert-danger" role="alert">
                <IconAlert size={17} />
                <span>{profileError}</span>
              </div>
            )}
            {profileNotice && (
              <div className="alert alert-ok" role="status">
                <IconCheck size={16} />
                <span>{profileNotice}</span>
              </div>
            )}

            <label className="field">
              <span>First Name</span>
              <input
                value={profileForm.first_name ?? ''}
                onChange={e => setProfileForm({ ...profileForm, first_name: e.target.value })}
                placeholder="John"
                maxLength={50}
                disabled={profileSaving}
              />
            </label>

            <label className="field">
              <span>Last Name</span>
              <input
                value={profileForm.last_name ?? ''}
                onChange={e => setProfileForm({ ...profileForm, last_name: e.target.value })}
                placeholder="Doe"
                maxLength={50}
                disabled={profileSaving}
              />
            </label>

            <footer className="modal-foot">
              <div className="modal-actions">
                <button type="submit" className="btn btn-primary" disabled={profileSaving}>
                  {profileSaving ? 'Saving…' : 'Save profile'}
                </button>
              </div>
            </footer>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Password</h2>
              <p>Your current password is required to set a new one.</p>
            </div>
          </div>

          <form className="form-stack" onSubmit={handlePasswordChange}>
            {passwordError && (
              <div className="alert alert-danger" role="alert">
                <IconAlert size={17} />
                <span>{passwordError}</span>
              </div>
            )}
            {passwordNotice && (
              <div className="alert alert-ok" role="status">
                <IconCheck size={16} />
                <span>{passwordNotice}</span>
              </div>
            )}

            <label className="field">
              <span>Current Password</span>
              <input
                type="password"
                value={passwordForm.current_password}
                onChange={e => setPasswordForm({ ...passwordForm, current_password: e.target.value })}
                autoComplete="current-password"
                required
                disabled={passwordSaving}
              />
            </label>

            <label className="field">
              <span>New Password</span>
              <input
                type="password"
                value={passwordForm.new_password}
                onChange={e => setPasswordForm({ ...passwordForm, new_password: e.target.value })}
                autoComplete="new-password"
                required
                minLength={8}
                disabled={passwordSaving}
              />
              <small className="field-hint">At least 8 characters.</small>
            </label>

            <label className="field">
              <span>Confirm New Password</span>
              <input
                type="password"
                value={passwordForm.confirm_password}
                onChange={e => setPasswordForm({ ...passwordForm, confirm_password: e.target.value })}
                autoComplete="new-password"
                required
                disabled={passwordSaving}
              />
            </label>

            <footer className="modal-foot">
              <div className="modal-actions">
                <button type="submit" className="btn btn-primary" disabled={passwordSaving}>
                  {passwordSaving ? 'Changing…' : 'Change password'}
                </button>
              </div>
            </footer>
          </form>
        </section>
      </div>
    </section>
  );
}