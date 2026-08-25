export class ScheduleEngine {
  #store;
  #now;

  constructor(store, { now = () => new Date() } = {}) {
    if (!store) throw new Error('ScheduleEngine requires store');
    this.#store = store;
    this.#now = now;
  }

  upsert({ schedule_id, every_ms, task }) {
    if (!Number.isInteger(every_ms) || every_ms < 100) throw new Error('schedule every_ms must be at least 100');
    const nextAt = new Date(this.#now().getTime() + every_ms).toISOString();
    this.#store.upsertSchedule({ schedule_id, every_ms, task, next_at: nextAt });
  }

  tick() {
    const now = this.#now().toISOString();
    const occurrences = [];
    for (const schedule of this.#store.listDueSchedules(now)) {
      const occurrenceId = `${schedule.schedule_id}@${schedule.next_at}`;
      const nextAt = new Date(Date.parse(schedule.next_at) + schedule.every_ms).toISOString();
      if (this.#store.createScheduleOccurrence({
        occurrence_id: occurrenceId,
        schedule_id: schedule.schedule_id,
        due_at: schedule.next_at,
        task: schedule.task,
        next_at: nextAt
      })) occurrences.push({ occurrence_id: occurrenceId, schedule_id: schedule.schedule_id, task: schedule.task });
    }
    return occurrences;
  }
}
