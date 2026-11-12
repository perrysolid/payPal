import React from 'react';
import { usd, time } from '../format.js';

const ITEM_LABEL = {
  SUCCESS: 'Completed', PENDING: 'Pending', UNCLAIMED: 'Unclaimed (recipient has no PayPal account)', ONHOLD: 'On hold',
  FAILED: 'Failed', RETURNED: 'Returned', BLOCKED: 'Blocked', REFUNDED: 'Refunded', REVERSED: 'Reversed', NOT_SUBMITTED: 'Not submitted',
};

export default function Settlement({ district: d, pledges, onRefresh, busy }) {
  const t = d.trigger;
  if (!t && !d.release) return null;

  if (!t && d.release) {
    const voided = pledges.filter((p) => p.districtId === d.id && p.status === 'VOIDED');
    return (
      <div className="panel settle">
        <div className="panel-head"><span className="panel-title">Release</span><span className="status released">Released</span></div>
        <div className="panel-pad">
          <p style={{ margin: 0 }}>The watch window closed without a trigger. {voided.length} authorization{voided.length === 1 ? '' : 's'} totalling <b className="mono">{usd(d.release.voidedCents)}</b> {voided.length === 1 ? 'was' : 'were'} voided. Donors were not charged. Other districts were not affected.</p>
          {d.release.voidFailures > 0 && <div className="inline-error" style={{ margin: '10px 0 0' }}>{d.release.voidFailures} void request(s) failed and remain held. Press Release again to retry.</div>}
        </div>
      </div>
    );
  }

  const items = t.payouts.flatMap((b) => b.items.map((i) => ({ ...i, batch: b })));
  const initiated = t.payouts.filter((b) => b.createState === 'CREATED');
  const completed = items.filter((i) => i.status === 'SUCCESS').reduce((s, i) => s + i.amountCents, 0);
  const failedCaptures = pledges.filter((p) => p.districtId === d.id && p.status === 'AUTHORIZED');
  const allocTotal = t.allocationTotalCents ?? 0;
  const reconciled = allocTotal === (t.capturedCents ?? 0);
  const payoutTotal = t.payouts.reduce((s, b) => s + b.amountCents, 0);
  const batch = t.payouts.at(-1);

  return (
    <div className="panel settle">
      <div className="panel-head">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="panel-title">Settlement</span>
          {t.simulated ? <span className="tag-sim">SIMULATED FORECAST DRILL</span> : <span className="tag-live">LIVE TRIGGER</span>}
          <span className="mono muted" style={{ fontSize: 11.5 }}>{t.id} · {time(t.at)}</span>
        </div>
        <button type="button" className="btn secondary" style={{ width: 'auto', padding: '5px 12px', fontSize: 12.5 }} onClick={onRefresh} disabled={busy}>
          {busy ? <span className="spinner" /> : null}Refresh payout status
        </button>
      </div>
      <div className="flow">
        <div className="flow-step">
          <div className="l"><span>1 · Held at trigger</span></div>
          <div className="v">{usd(t.heldAtTriggerCents)}</div>
          <div className="s">PayPal authorizations (not yet charged)</div>
        </div>
        <div className="flow-step">
          <div className="l"><span>2 · Captured</span>{failedCaptures.length ? <span className="cell-status st-bad">{failedCaptures.length} FAILED</span> : null}</div>
          <div className="v">{usd(t.capturedCents)}</div>
          <div className="s">{failedCaptures.length ? `${failedCaptures.length} capture(s) failed; press Re-check settlement to retry` : 'Donor funds captured into the sandbox merchant account'}</div>
        </div>
        <div className="flow-step">
          <div className="l"><span>3 · Payout initiated</span>{batch && <span className={`cell-status ${batch.createState === 'REQUEST_FAILED' ? 'st-bad' : batch.batchStatus === 'SUCCESS' ? 'st-ok' : 'st-pending'}`}>{batch.createState === 'REQUEST_FAILED' ? 'REQUEST FAILED' : batch.batchStatus}</span>}</div>
          <div className="v">{usd(initiated.reduce((s, b) => s + b.amountCents, 0))}</div>
          <div className="s mono" style={{ fontSize: 11 }}>{batch ? (batch.payoutBatchId || batch.senderBatchId) : t.capturedCents ? 'Not yet initiated' : 'Nothing captured, no payout'}</div>
          {batch?.error && <div className="s" style={{ color: 'var(--danger)' }}>{batch.error}</div>}
        </div>
        <div className="flow-step">
          <div className="l"><span>4 · Payout completed</span></div>
          <div className="v">{usd(completed)}</div>
          <div className="s">{items.length ? items.map((i) => ITEM_LABEL[i.status] || i.status).join(', ') : '—'}</div>
        </div>
      </div>

      <div className="settle-grid" style={{ borderTop: '1px solid var(--line-2)' }}>
        <div>
          <div className="panel-pad" style={{ paddingBottom: 8 }}>
            <div className="eyebrow">Relief partner payout</div>
          </div>
          {items.length ? (
            <table className="alloc">
              <thead><tr><th>Recipient</th><th>Status</th><th>Item ID</th><th className="n">Amount</th></tr></thead>
              <tbody>{items.map((i) => (
                <tr key={i.senderItemId}>
                  <td>{i.partnerName} <span className="tag-sample">SAMPLE</span><div className="muted mono" style={{ fontSize: 11 }}>{i.receiver}</div></td>
                  <td>{ITEM_LABEL[i.status] || i.status}{i.errors ? <div className="muted" style={{ fontSize: 11 }}>{i.errors}</div> : null}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{i.payoutItemId || '—'}</td>
                  <td className="n">{usd(i.amountCents)}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <div className="empty">No payout items.</div>}
          <div className="reconcile">
            <span className={`check ${payoutTotal <= (t.capturedCents ?? 0) ? '' : 'bad'}`}>{payoutTotal <= (t.capturedCents ?? 0) ? '✓' : '✗'}</span>
            <span>Payout total {usd(payoutTotal)} does not exceed captured {usd(t.capturedCents)} (enforced on the server).</span>
          </div>
          <div className="panel-pad" style={{ borderTop: '1px solid var(--line-2)', fontSize: 12.5, color: 'var(--ink-2)' }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>What these states mean</div>
            <p style={{ margin: '0 0 6px' }}><b>Authorization</b>: a hold on the donor’s PayPal funds. Nothing is charged.</p>
            <p style={{ margin: '0 0 6px' }}><b>Capture</b>: the held amount is charged after the deterministic trigger.</p>
            <p style={{ margin: '0 0 6px' }}><b>Payout initiated</b>: PayPal accepted the batch. <b>Completed</b> is shown only once PayPal reports the item as SUCCESS.</p>
            <p style={{ margin: 0 }}><b>Allocation</b>: a ledger instruction to the relief partner, not a PayPal transfer.</p>
          </div>
        </div>
        <div>
          <div className="panel-pad" style={{ paddingBottom: 8, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <div className="eyebrow">Household allocation ledger</div>
            <span className="tag-sample">SAMPLE HOUSEHOLDS</span>
          </div>
          {t.allocations.length ? (
            <table className="alloc">
              <thead><tr><th>Household</th><th>Zone</th><th className="n">Members</th><th className="n">Allocation</th></tr></thead>
              <tbody>{t.allocations.map((a) => (
                <tr key={a.householdId}><td>{a.label}</td><td><span className={`zone-pill ${a.zone}`}>{a.zone}</span></td><td className="n">{a.members}</td><td className="n">{usd(a.amountCents)}</td></tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={3}>Total allocated</td><td className="n">{usd(allocTotal)}</td></tr></tfoot>
            </table>
          ) : <div className="empty">No captured funds to allocate.</div>}
          <div className="reconcile">
            <span className={`check ${reconciled ? '' : 'bad'}`}>{reconciled ? '✓' : '✗'}</span>
            <span>Allocations {usd(allocTotal)} {reconciled ? 'reconcile exactly to' : 'DO NOT match'} captured {usd(t.capturedCents)}. Integer-cent largest-remainder rounding. These are ledger entries for the relief partner, not PayPal transfers to households.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
