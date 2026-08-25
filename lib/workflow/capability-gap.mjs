export function computeCapabilityGap(requiredCapabilities, availableCapabilities) {
  if (!Array.isArray(requiredCapabilities) || !Array.isArray(availableCapabilities)) {
    throw new TypeError('requiredCapabilities and availableCapabilities must be arrays');
  }
  const available = new Set(availableCapabilities);
  const missing = [];
  for (const capability of requiredCapabilities) {
    if (typeof capability !== 'string' || capability.length === 0) {
      throw new TypeError('capabilities must be non-empty strings');
    }
    if (!available.has(capability) && !missing.includes(capability)) missing.push(capability);
  }
  return missing;
}
