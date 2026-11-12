import React, { useMemo } from 'react';
import { BryntumScheduler } from '@bryntum/scheduler-react-enterprise';
import '@bryntum/core-enterprise/core.thin.css';
import '@bryntum/grid-enterprise/grid.thin.css';
import '@bryntum/scheduler-enterprise/scheduler.thin.css';
import '@bryntum/scheduler-enterprise/svalbard-light.css';

// Response and payment schedule: Claude's response steps, the registration window and each
// payment round (part 1 now, part 2 after review), on one Bryntum Scheduler timeline.
export default function Schedule({ district: d, assessment, licenseKey }) {
  if (licenseKey && globalThis.bryntum) globalThis.bryntum.licenseKey = licenseKey;
  const t = d.trigger;
  const start = new Date(t?.at || Date.now());
  const data = useMemo(() => {
    const resources = [];
    const events = [];
    const res = (name) => {
      let r = resources.find((x) => x.name === name);
      if (!r) { r = { id: resources.length + 1, name }; resources.push(r); }
      return r.id;
    };
    const at = (h) => new Date(start.getTime() + h * 3600_000);
    (assessment?.responseSteps || []).forEach((s, i) => events.push({ id: `s${i}`, resourceId: res(s.owner), name: s.title, startDate: at(s.startHourOffset), endDate: at(s.startHourOffset + s.durationHours), eventColor: i === 0 ? 'red' : 'blue' }));
    if (t?.registrationClosesAt) events.push({ id: 'reg', resourceId: res('Household registration'), name: 'Registration open (verified PayPal accounts)', startDate: start, endDate: new Date(t.registrationClosesAt), eventColor: 'teal' });
    (t?.rounds || []).forEach((r) => {
      events.push({ id: `r${r.no}a`, resourceId: res('PayPal payments'), name: `Round ${r.no}: part 1 to ${r.households} household(s)`, startDate: new Date(r.at), endDate: new Date(Date.parse(r.at) + 2 * 3600_000), eventColor: 'green' });
      events.push({ id: `r${r.no}b`, resourceId: res('PayPal payments'), name: `Round ${r.no}: part 2 after review`, startDate: new Date(r.part2DueAt), endDate: new Date(Date.parse(r.part2DueAt) + 2 * 3600_000), eventColor: 'orange' });
    });
    return { resources, events };
  }, [assessment, t, start]);

  const ends = data.events.map((e) => e.endDate.getTime());
  const endDate = new Date(Math.max(start.getTime() + 72 * 3600_000, ...ends) + 6 * 3600_000);
  return (
    <div className="sched-host">
      <BryntumScheduler
        startDate={new Date(start.getTime() - 3 * 3600_000)}
        endDate={endDate}
        viewPreset="dayAndWeek"
        rowHeight={40}
        barMargin={6}
        readOnly
        columns={[{ text: 'Team', field: 'name', width: 170 }]}
        resources={data.resources}
        events={data.events}
      />
    </div>
  );
}
