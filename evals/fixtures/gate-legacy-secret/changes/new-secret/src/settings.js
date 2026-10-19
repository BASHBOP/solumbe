// Corpus fixture: a credential that was already on the base before the change.
// The marker below is stripped by the gate-effectiveness harness before the
// baseline commit, so the gate sees a bare credential that the change did not
// add.
const LEGACY_KEY = "AKIA3F7QZL2MXN8RTVWB"; // solumbe:allow-secret
const SECOND_KEY = "AKIA7K2PQRX9MZL4VTNB"; // solumbe:allow-secret
export const settings = { region: "eu-west-2", key: LEGACY_KEY, backup: SECOND_KEY };
