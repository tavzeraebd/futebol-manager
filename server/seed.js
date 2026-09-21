/*
 * Catálogo local de exemplo (elencos reais, valores e notas APROXIMADOS, escritos à mão).
 * Serve de base quando não há dados do Sofascore em data/catalog.sofascore.json.
 * Linha de jogador: [nome, clube, posição, valor de mercado (M€), nota geral 0-100]
 * Linha de técnico: [nome, clube, custo (M€), nota geral 0-100]
 */
const P = [
  // Goleiros
  ['Thibaut Courtois', 'Real Madrid', 'GK', 25, 89],
  ['Alisson', 'Liverpool', 'GK', 25, 88],
  ['Gianluigi Donnarumma', 'Manchester City', 'GK', 40, 87],
  ['Mike Maignan', 'Milan', 'GK', 35, 86],
  ['Jan Oblak', 'Atlético de Madrid', 'GK', 25, 86],
  ['Emiliano Martínez', 'Aston Villa', 'GK', 30, 85],
  ['Marc-André ter Stegen', 'Barcelona', 'GK', 18, 84],
  ['David Raya', 'Arsenal', 'GK', 30, 84],
  ['Gregor Kobel', 'Borussia Dortmund', 'GK', 35, 84],
  ['Ederson', 'Fenerbahçe', 'GK', 20, 84],
  ['Guglielmo Vicario', 'Tottenham', 'GK', 20, 80],
  ['Jordan Pickford', 'Everton', 'GK', 25, 82],
  ['Yann Sommer', 'Inter', 'GK', 10, 82],
  ['Manuel Neuer', 'Bayern de Munique', 'GK', 4, 80],
  ['Matz Sels', 'Nottingham Forest', 'GK', 18, 78],
  ['Andriy Lunin', 'Real Madrid', 'GK', 20, 78],
  ['Carl Rushworth', 'Coventry City', 'GK', 8, 72],

  // Zagueiros
  ['Virgil van Dijk', 'Liverpool', 'CB', 25, 88],
  ['William Saliba', 'Arsenal', 'CB', 90, 88],
  ['Gabriel Magalhães', 'Arsenal', 'CB', 75, 87],
  ['Rúben Dias', 'Manchester City', 'CB', 60, 87],
  ['Alessandro Bastoni', 'Inter', 'CB', 70, 87],
  ['Josko Gvardiol', 'Manchester City', 'CB', 75, 86],
  ['Antonio Rüdiger', 'Real Madrid', 'CB', 25, 85],
  ['Marquinhos', 'Paris Saint-Germain', 'CB', 35, 85],
  ['Éder Militão', 'Real Madrid', 'CB', 40, 84],
  ['Dayot Upamecano', 'Bayern de Munique', 'CB', 45, 84],
  ['Ronald Araújo', 'Barcelona', 'CB', 55, 84],
  ['Pau Cubarsí', 'Barcelona', 'CB', 80, 84],
  ['Ibrahima Konaté', 'Liverpool', 'CB', 45, 84],
  ['Riccardo Calafiori', 'Arsenal', 'CB', 55, 84],
  ['Alessio Romagnoli', 'Lazio', 'CB', 8, 78],
  ['Gleison Bremer', 'Juventus', 'CB', 40, 83],
  ['John Stones', 'Manchester City', 'CB', 30, 83],
  ['Murillo', 'Nottingham Forest', 'CB', 35, 82],
  ['Kim Min-jae', 'Bayern de Munique', 'CB', 35, 82],
  ['Nikola Milenković', 'Nottingham Forest', 'CB', 22, 80],
  ['Ezri Konsa', 'Aston Villa', 'CB', 30, 80],
  ['Harry Maguire', 'Manchester United', 'CB', 15, 79],
  ['Lewis Dunk', 'Brighton', 'CB', 8, 79],
  ['Sergio Ramos', 'Monterrey', 'CB', 3, 76],
  ['Bobby Thomas', 'Coventry City', 'CB', 4, 72],
  ['Luis Binks', 'Coventry City', 'CB', 6, 72],
  // Laterais
  ['Achraf Hakimi', 'Paris Saint-Germain', 'RB', 70, 87],
  ['Trent Alexander-Arnold', 'Real Madrid', 'RB', 70, 86],
  ['Pedro Porro', 'Tottenham', 'RB', 40, 83],
  ['Jeremie Frimpong', 'Liverpool', 'RB', 40, 82],
  ['Kyle Walker', 'Burnley', 'RB', 8, 80],
  ['Joe Gomez', 'Liverpool', 'RB', 12, 78],
  ['Ola Aina', 'Nottingham Forest', 'RB', 12, 78],
  ['Kieran Trippier', 'Newcastle', 'RB', 5, 76],
  ['Milan van Ewijk', 'Coventry City', 'RB', 8, 74],
  ['Theo Hernández', 'Al-Hilal', 'LB', 45, 84],
  ['Alphonso Davies', 'Bayern de Munique', 'LB', 50, 82],
  ['Nuno Mendes', 'Paris Saint-Germain', 'LB', 70, 86],
  ['Marc Cucurella', 'Chelsea', 'LB', 40, 82],
  ['Andrew Robertson', 'Liverpool', 'LB', 20, 80],
  ['Milos Kerkez', 'Liverpool', 'LB', 40, 80],
  ['Neco Williams', 'Nottingham Forest', 'LB', 15, 78],
  ['Jay Dasilva', 'Coventry City', 'LB', 4, 72],

  // Meio-campistas
  ['Rodri', 'Manchester City', 'DM', 100, 91],
  ['Vitinha', 'Paris Saint-Germain', 'CM', 90, 88],
  ['Declan Rice', 'Arsenal', 'DM', 120, 88],
  ['Federico Valverde', 'Real Madrid', 'CM', 100, 88],
  ['Pedri', 'Barcelona', 'CM', 100, 89],
  ['Nicolò Barella', 'Inter', 'CM', 70, 86],
  ['Joshua Kimmich', 'Bayern de Munique', 'DM', 45, 87],
  ['Bernardo Silva', 'Manchester City', 'CM', 50, 87],
  ['Martin Zubimendi', 'Arsenal', 'DM', 60, 84],
  ['Aurélien Tchouaméni', 'Real Madrid', 'DM', 70, 85],
  ['Eduardo Camavinga', 'Real Madrid', 'CM', 60, 84],
  ['Alexis Mac Allister', 'Liverpool', 'CM', 70, 85],
  ['Enzo Fernández', 'Chelsea', 'CM', 75, 84],
  ['Moisés Caicedo', 'Chelsea', 'DM', 90, 84],
  ['Bruno Guimarães', 'Newcastle', 'CM', 80, 85],
  ['Fabián Ruiz', 'Paris Saint-Germain', 'CM', 40, 83],
  ['Gavi', 'Barcelona', 'CM', 60, 83],
  ['Lucas Paquetá', 'West Ham', 'CM', 45, 82],
  ['Luka Modrić', 'Milan', 'CM', 5, 82],
  ['Ilkay Gündoğan', 'Galatasaray', 'CM', 10, 80],
  ['Casemiro', 'Manchester United', 'DM', 8, 79],
  ['Elliot Anderson', 'Nottingham Forest', 'DM', 35, 81],
  ['Ryan Yates', 'Nottingham Forest', 'DM', 12, 76],
  ['Jordan Henderson', 'Brentford', 'DM', 3, 74],
  ['Ben Sheaf', 'Coventry City', 'DM', 6, 72],
  ['Josh Eccles', 'Coventry City', 'DM', 5, 72],
  ['Jamal Musiala', 'Bayern de Munique', 'AM', 120, 89],
  ['Jude Bellingham', 'Real Madrid', 'AM', 160, 90],
  ['Florian Wirtz', 'Liverpool', 'AM', 120, 88],
  ['Cole Palmer', 'Chelsea', 'AM', 100, 88],
  ['Martin Ødegaard', 'Arsenal', 'AM', 80, 86],
  ['Bruno Fernandes', 'Manchester United', 'AM', 50, 86],
  ['Kevin De Bruyne', 'Napoli', 'AM', 25, 86],
  ['Dominik Szoboszlai', 'Liverpool', 'AM', 80, 85],
  ['Morgan Gibbs-White', 'Nottingham Forest', 'AM', 40, 82],
  ['Thomas Müller', 'Vancouver Whitecaps', 'AM', 4, 78],
  ['Victor Torp', 'Coventry City', 'AM', 6, 73],
  ['Jack Rudoni', 'Coventry City', 'AM', 8, 74],

  // Atacantes
  ['Erling Haaland', 'Manchester City', 'ST', 180, 91],
  ['Kylian Mbappé', 'Real Madrid', 'ST', 180, 91],
  ['Harry Kane', 'Bayern de Munique', 'ST', 70, 90],
  ['Lautaro Martínez', 'Inter', 'ST', 100, 87],
  ['Alexander Isak', 'Liverpool', 'ST', 120, 87],
  ['Viktor Gyökeres', 'Arsenal', 'ST', 75, 85],
  ['Victor Osimhen', 'Galatasaray', 'ST', 75, 85],
  ['Julián Álvarez', 'Atlético de Madrid', 'ST', 90, 86],
  ['Robert Lewandowski', 'Barcelona', 'ST', 12, 84],
  ['Hugo Ekitike', 'Liverpool', 'ST', 60, 84],
  ['Benjamin Šeško', 'Manchester United', 'ST', 70, 83],
  ['Ollie Watkins', 'Aston Villa', 'ST', 40, 83],
  ['Dušan Vlahović', 'Juventus', 'ST', 35, 82],
  ['Chris Wood', 'Nottingham Forest', 'ST', 20, 79],
  ['Ellis Simms', 'Coventry City', 'ST', 15, 75],
  ['Haji Wright', 'Coventry City', 'ST', 10, 75],
  ['Jamie Vardy', 'Cremonese', 'ST', 3, 74],
  ['Olivier Giroud', 'Lille', 'ST', 1, 72],
  ['Lamine Yamal', 'Barcelona', 'RW', 180, 90],
  ['Ousmane Dembélé', 'Paris Saint-Germain', 'RW', 90, 89],
  ['Mohamed Salah', 'Liverpool', 'RW', 50, 89],
  ['Bukayo Saka', 'Arsenal', 'RW', 130, 88],
  ['Raphinha', 'Barcelona', 'RW', 80, 88],
  ['Michael Olise', 'Bayern de Munique', 'RW', 80, 86],
  ['Phil Foden', 'Manchester City', 'RW', 100, 86],
  ['Rodrygo', 'Real Madrid', 'RW', 80, 84],
  ['Estêvão', 'Chelsea', 'RW', 60, 83],
  ['Bryan Mbeumo', 'Manchester United', 'RW', 65, 83],
  ['Ademola Lookman', 'Atalanta', 'RW', 40, 83],
  ['Anthony Elanga', 'Nottingham Forest', 'RW', 20, 78],
  ['Vinícius Júnior', 'Real Madrid', 'LW', 150, 89],
  ['Khvicha Kvaratskhelia', 'Paris Saint-Germain', 'LW', 80, 87],
  ['Luis Díaz', 'Bayern de Munique', 'LW', 75, 86],
  ['Nico Williams', 'Athletic Club', 'LW', 60, 84],
  ['Rafael Leão', 'Milan', 'LW', 70, 84],
  ['Cody Gakpo', 'Liverpool', 'LW', 55, 83],
  ['Matheus Cunha', 'Manchester United', 'LW', 70, 83],
  ['Gabriel Martinelli', 'Arsenal', 'LW', 60, 82],
  ['Callum Hudson-Odoi', 'Nottingham Forest', 'LW', 25, 78],
  ['Brandon Thomas-Asante', 'Coventry City', 'LW', 8, 74]
];

const C = [
  ['Pep Guardiola', 'Manchester City', 30, 93],
  ['Luis Enrique', 'Paris Saint-Germain', 25, 91],
  ['Carlo Ancelotti', 'Seleção Brasileira', 12, 91],
  ['Hansi Flick', 'Barcelona', 15, 89],
  ['Mikel Arteta', 'Arsenal', 25, 89],
  ['Arne Slot', 'Liverpool', 20, 88],
  ['Simone Inzaghi', 'Al-Hilal', 12, 88],
  ['Diego Simeone', 'Atlético de Madrid', 10, 87],
  ['Antonio Conte', 'Napoli', 10, 87],
  ['Unai Emery', 'Aston Villa', 10, 87],
  ['Thomas Tuchel', 'Seleção Inglesa', 10, 86],
  ['Xabi Alonso', 'Real Madrid', 15, 86],
  ['Enzo Maresca', 'Chelsea', 10, 84],
  ['Nuno Espírito Santo', 'West Ham', 8, 84],
  ['Roberto De Zerbi', 'Olympique de Marseille', 6, 82],
  ['Ruben Amorim', 'Manchester United', 8, 80],
  ['Sean Dyche', 'Nottingham Forest', 5, 78],
  ['Frank Lampard', 'Coventry City', 3, 76]
];

const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function shortName(name) {
  const t = name.split(' ');
  if (t.length === 1) return name;
  let i = t.length - 1;
  while (i > 1 && /^[a-zà-ú]/.test(t[i - 1])) i--;
  return t.slice(i).join(' ');
}

const ROLE = { GK: 'GK', CB: 'DEF', RB: 'DEF', LB: 'DEF', RWB: 'DEF', LWB: 'DEF', DM: 'MID', CM: 'MID', AM: 'MID', RM: 'MID', LM: 'MID', RW: 'FWD', LW: 'FWD', ST: 'FWD' };

module.exports = {
  ROLE,
  slug,
  players: P.map(([name, club, pos, value, ovr]) => ({
    id: slug(name), name, short: shortName(name), club, pos, role: ROLE[pos], value: value * 1e6, ovr
  })),
  coaches: C.map(([name, club, value, ovr]) => ({ id: 'c-' + slug(name), name, short: shortName(name), club, value: value * 1e6, ovr }))
};
