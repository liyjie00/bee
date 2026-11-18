import { useState } from 'react';
import { RESOLUTIONS, type Resolution } from '@bee/shared';
import { Icon } from '../components/Icon';
import { useT, type MessageKey } from '../i18n';

/** Asked when a ticket moves to a "done" status that requires a resolution. */
export function ResolutionDialog({
  onPick,
  onCancel,
}: {
  onPick(r: Resolution): void;
  onCancel(): void;
}) {
  const t = useT();
  const [r, setR] = useState<Resolution>('done');
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tkResTitle"
        style={{ width: 'min(24rem,100%)' }}
      >
        <div className="mh">
          <h3 id="tkResTitle">{t('tk.res.title')}</h3>
          <button className="ico" aria-label={t('common.close')} onClick={onCancel}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb tk-res">
          {RESOLUTIONS.map((x) => (
            <label key={x}>
              <input type="radio" name="res" checked={r === x} onChange={() => setR(x)} />
              {t(`tk.res.${x}` as MessageKey)}
            </label>
          ))}
        </div>
        <div className="mf">
          <div className="spacer" />
          <button className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={() => onPick(r)}>
            {t('tk.res.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
