// A failure that says what probably happened and what to do: `<problem>. Fix: <fix>.`
export class ShepherdError extends Error {
  constructor({ code, problem, fix }) {
    const p = String(problem).replace(/\.$/, '');
    const f = String(fix).replace(/\.$/, '');
    super(`${p}. Fix: ${f}.`);
    this.name = 'ShepherdError';
    this.code = code;
    this.problem = p;
    this.fix = f;
  }
}
