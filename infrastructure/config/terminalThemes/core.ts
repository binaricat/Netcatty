import type { TerminalTheme } from '../../../domain/models';

export const coreTerminalThemes: TerminalTheme[] = [
  {
    id: 'netcatty-dark',
    name: 'Netcatty Dark',
    type: 'dark',
    colors: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selection: '#264f78',
      black: '#0d1117',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc'
    }
  },
  {
    id: 'netcatty-light',
    name: 'Netcatty Light',
    type: 'light',
    colors: {
      background: '#f6f8fa',
      foreground: '#24292f',
      cursor: '#0969da',
      selection: '#add6ff',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#9a6700',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#0e7574',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#7d4e00',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#0c7875',
      brightWhite: '#8c959f'
    }
  },
];
