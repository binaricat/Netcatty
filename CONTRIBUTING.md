# Contributing to Netcatty

Thank you for your interest in contributing to Netcatty — an AI-powered SSH client, SFTP browser, and terminal manager built with Electron, React, and xterm.js.

Please read this guide before submitting issues or pull requests.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold this standard.

## Ways to Contribute

- Report bugs via [GitHub Issues](https://github.com/binaricat/Netcatty/issues)
- Suggest features or improvements
- Fix bugs or implement features listed in Issues
- Improve documentation

## Development Setup

**Prerequisites:** Node.js 22+ and npm.

```bash
# Clone the repository
git clone https://github.com/binaricat/Netcatty.git
cd Netcatty

# Install dependencies
npm ci

# Start in development mode (Vite + Electron)
npm run dev
```

## Build & Package

```bash
npm run build          # Build for production
npm run pack           # Package for current platform
npm run pack:mac       # macOS (DMG + ZIP)
npm run pack:win       # Windows (NSIS, portable, ZIP)
npm run pack:linux     # Linux (AppImage, DEB, RPM, pacman)
```

## Linting and Tests

```bash
npm run lint           # Run ESLint
npm test               # Run the test suite
```

## Pull Request Process

1. Fork the repository.
2. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Make your changes, following the existing project style.
4. Commit with a clear message:
   ```bash
   git commit -m 'feat: add amazing feature'
   ```
5. Push the branch and open a Pull Request against `main`.
6. Run `npm run lint` and `npm test` before requesting review.
7. If you changed the capability catalog, run `npm run generate:capability-tools`
   and commit any generated updates.
8. Ensure all CI checks pass before requesting review.

## Commit Message Convention

We recommend following [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `refactor:` — code change without feature or fix
- `chore:` — build process or tooling changes

## Architecture & Coding Guidelines

Netcatty is organized around three layers:

- Domain logic in `domain/`
- Application state in `application/state/`
- UI components in `components/`

Keep side effects in application or infrastructure code, avoid direct
`localStorage` or network calls from components, and update relevant
documentation when behavior changes.

## License

By contributing, you agree that your contributions will be licensed under the [GPL-3.0 License](./LICENSE).
