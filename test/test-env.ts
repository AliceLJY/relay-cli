// Tests may run inside a duo child agent. Inherited DUO_DIR points at the
// live relay state and must not make temporary test roots write there.
delete process.env.DUO_DIR;
