/*
 * Dados das equipes.
 * fx: posição ao longo do campo (0 = próprio gol, 1 = gol adversário)
 * fy: posição lateral (0 = topo, 1 = base) para uma equipe atacando para a direita.
 * role: GK | DEF | MID | FWD   (define velocidade e comportamento)
 * skill (opcional): multiplicadores { pass, shot, def, dribble } e speed.
 */
(function (g) {
  'use strict';

  g.TEAM_DATA = {
    home: {
      name: 'Nottingham Forest',
      short: 'NFO',
      formation: '4-2-3-1',
      coach: 'Nuno Espírito Santo',
      colors: { shirt: '#d71920', number: '#ffffff', trim: '#ffffff', gk: '#f2c200', gkNumber: '#111111' },
      players: [
        { num: 26, name: 'Matz Sels',          short: 'Sels',        role: 'GK',  pos: 'GK', fx: 0.04, fy: 0.50 },
        { num: 34, name: 'Ola Aina',           short: 'Aina',        role: 'DEF', pos: 'RB', fx: 0.24, fy: 0.86 },
        { num: 5,  name: 'Murillo',            short: 'Murillo',     role: 'DEF', pos: 'CB', fx: 0.21, fy: 0.63, skill: { def: 1.1 } },
        { num: 31, name: 'Nikola Milenković',  short: 'Milenković',  role: 'DEF', pos: 'CB', fx: 0.21, fy: 0.37, skill: { def: 1.1 } },
        { num: 3,  name: 'Neco Williams',      short: 'N. Williams', role: 'DEF', pos: 'LB', fx: 0.24, fy: 0.14 },
        { num: 8,  name: 'Elliot Anderson',    short: 'Anderson',    role: 'MID', pos: 'DM', fx: 0.40, fy: 0.62, skill: { pass: 1.1 } },
        { num: 22, name: 'Ryan Yates',         short: 'Yates',       role: 'MID', pos: 'DM', fx: 0.40, fy: 0.38, skill: { def: 1.1 } },
        { num: 21, name: 'Anthony Elanga',     short: 'Elanga',      role: 'FWD', pos: 'RW', fx: 0.58, fy: 0.86, speed: 1.05, skill: { dribble: 1.1 } },
        { num: 10, name: 'Morgan Gibbs-White', short: 'Gibbs-White', role: 'MID', pos: 'AM', fx: 0.58, fy: 0.50, skill: { pass: 1.2, shot: 1.05 } },
        { num: 14, name: 'Callum Hudson-Odoi', short: 'Hudson-Odoi', role: 'FWD', pos: 'LW', fx: 0.58, fy: 0.14, skill: { dribble: 1.15 } },
        { num: 11, name: 'Chris Wood',         short: 'Wood',        role: 'FWD', pos: 'ST', fx: 0.77, fy: 0.50, skill: { shot: 1.25 } }
      ]
    },
    away: {
      name: 'Coventry City',
      short: 'COV',
      formation: '4-2-3-1',
      coach: 'Frank Lampard',
      colors: { shirt: '#5bb4ea', number: '#0b2545', trim: '#0b2545', gk: '#ff7a1a', gkNumber: '#111111' },
      players: [
        { num: 1,  name: 'Carl Rushworth',     short: 'Rushworth',   role: 'GK',  pos: 'GK', fx: 0.04, fy: 0.50 },
        { num: 27, name: 'Milan van Ewijk',    short: 'van Ewijk',   role: 'DEF', pos: 'RB', fx: 0.24, fy: 0.86 },
        { num: 4,  name: 'Bobby Thomas',       short: 'B. Thomas',   role: 'DEF', pos: 'CB', fx: 0.21, fy: 0.63 },
        { num: 5,  name: 'Luis Binks',         short: 'Binks',       role: 'DEF', pos: 'CB', fx: 0.21, fy: 0.37 },
        { num: 3,  name: 'Jay Dasilva',        short: 'Dasilva',     role: 'DEF', pos: 'LB', fx: 0.24, fy: 0.14 },
        { num: 14, name: 'Ben Sheaf',          short: 'Sheaf',       role: 'MID', pos: 'DM', fx: 0.40, fy: 0.62, skill: { pass: 1.1 } },
        { num: 28, name: 'Josh Eccles',        short: 'Eccles',      role: 'MID', pos: 'DM', fx: 0.40, fy: 0.38, skill: { def: 1.1 } },
        { num: 13, name: 'Jack Rudoni',        short: 'Rudoni',      role: 'FWD', pos: 'RW', fx: 0.58, fy: 0.86, skill: { dribble: 1.1 } },
        { num: 29, name: 'Victor Torp',        short: 'Torp',        role: 'MID', pos: 'AM', fx: 0.58, fy: 0.50, skill: { pass: 1.15 } },
        { num: 19, name: 'Brandon Thomas-Asante', short: 'Thomas-Asante', role: 'FWD', pos: 'LW', fx: 0.58, fy: 0.14, speed: 1.05 },
        { num: 9,  name: 'Ellis Simms',        short: 'Simms',       role: 'FWD', pos: 'ST', fx: 0.77, fy: 0.50, skill: { shot: 1.2 } }
      ]
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
