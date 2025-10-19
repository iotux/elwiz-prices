const { parseISO, formatISO } = require("date-fns");

function normalizeSeries({ points, targetInterval }) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }

  const sorted = points
    .map((point) => ({
      start: toLocalIso(point.start),
      end: toLocalIso(point.end),
      value: Number(point.value),
      currency: point.currency,
    }))
    .filter(
      (point) =>
        point.start &&
        point.end &&
        !Number.isNaN(point.value) &&
        isValidDate(point.start) &&
        isValidDate(point.end),
    )
    .sort((a, b) => parseISO(a.start) - parseISO(b.start));

  const sourceInterval = detectInterval(sorted);

  if (targetInterval === "1h") {
    if (sourceInterval === "1h") {
      return sorted;
    }
    return aggregateToHourly(sorted);
  }

  if (targetInterval === "15m") {
    if (sourceInterval === "15m") {
      return sorted;
    }
    return expandToQuarterHour(sorted);
  }

  return sorted;
}

function detectInterval(points) {
  if (points.length < 2) {
    return null;
  }
  const first = new Date(points[0].start);
  const second = new Date(points[1].start);
  const diffMinutes = Math.round((second - first) / 60000);
  if (diffMinutes === 15) {
    return "15m";
  }
  if (diffMinutes === 60) {
    return "1h";
  }
  return points.length > 48 ? "15m" : "1h";
}

function aggregateToHourly(points) {
  const buckets = new Map();
  for (const point of points) {
    const hourStart = parseISO(point.start);
    hourStart.setMinutes(0, 0, 0);
    const key = hourStart.toISOString();
    const bucket = buckets.get(key) || {
      start: point.start,
      end: point.end,
      sum: 0,
      count: 0,
      currency: point.currency,
    };

    bucket.sum += point.value;
    bucket.count += 1;

    if (parseISO(point.start) < parseISO(bucket.start)) {
      bucket.start = point.start;
    }

    if (parseISO(point.end) > parseISO(bucket.end)) {
      bucket.end = point.end;
    }

    if (!bucket.currency) {
      bucket.currency = point.currency;
    }

    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .sort((a, b) => parseISO(a.start) - parseISO(b.start))
    .map((bucket) => ({
      start: bucket.start,
      end: bucket.end,
      value:
        bucket.count > 0 ? bucket.sum / bucket.count : Number(bucket.sum || 0),
      currency: bucket.currency,
    }));
}

function expandToQuarterHour(points) {
  const expanded = [];

  for (const point of points) {
    const baseStart = parseISO(point.start);
    const baseEnd = point.end ? parseISO(point.end) : null;
    const durationMinutes = baseEnd
      ? Math.max(15, Math.round((baseEnd - baseStart) / 60000))
      : 60;
    const slices = Math.max(1, Math.round(durationMinutes / 15));
    const sliceValue = point.value / slices;

    for (let index = 0; index < slices; index++) {
      const sliceStart = new Date(baseStart);
      sliceStart.setMinutes(sliceStart.getMinutes() + index * 15);
      const sliceEnd = new Date(sliceStart);
      sliceEnd.setMinutes(sliceStart.getMinutes() + 15);

      expanded.push({
        start: formatISO(sliceStart, { representation: "complete" }),
        end: formatISO(sliceEnd, { representation: "complete" }),
        value: sliceValue,
        currency: point.currency,
      });
    }
  }

  return expanded.sort((a, b) => parseISO(a.start) - parseISO(b.start));
}

function toLocalIso(value) {
  if (!value) {
    return value;
  }
  if (typeof value === "string") {
    const date = parseISO(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return formatISO(date, { representation: "complete" });
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : formatISO(date, { representation: "complete" });
}

module.exports = {
  normalizeSeries,
};

function isValidDate(value) {
  const date = parseISO(value);
  return !Number.isNaN(date.getTime());
}
