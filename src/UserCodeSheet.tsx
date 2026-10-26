import { useEffect, useRef, useState } from 'react';
import { USER_CODE_MAX, normalizeUserCode, userCodeError } from './lib/types';

/** Bottom sheet asking for this phone's User Code. The reading form stays mounted underneath, so nothing typed is lost. */
export default function UserCodeSheet({ onSave, onCancel }: { onSave: (code: string) => void; onCancel: () => void }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const submit = () => {
    const c = normalizeUserCode(v);
    const e = userCodeError(c);
    if (e) return setErr(e);
    onSave(c);
  };
  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="uc-title" data-testid="uc-sheet"
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
        <h3 id="uc-title">Set your User Code</h3>
        <p className="small">Each reading records the User Code of the person who took it. Set it once for this phone; you can change it later in Settings.</p>
        <label>User Code
          <input ref={input} value={v} maxLength={USER_CODE_MAX + 5} autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            onChange={(e) => { setV(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            placeholder="e.g. OD-1" data-testid="uc-prompt-input" />
        </label>
        <p className="muted small">Up to {USER_CODE_MAX} letters, numbers, - or _ (saved in capitals).</p>
        {err && <p className="error" role="alert" data-testid="uc-prompt-error">{err}</p>}
        <button type="button" className="primary" onClick={submit} data-testid="uc-prompt-save">Save code and reading</button>
        <button type="button" onClick={onCancel} data-testid="uc-prompt-cancel">Cancel</button>
      </div>
    </div>
  );
}
