# Analytics Backend

Self-hosted analytics backend using ClickHouse.

## Development

### Prerequisites

- Node.js (v22.1.0 or higher)
- npm

### Installation

```bash
npm install
```

### Running the Application

```bash
# Development mode
npm run dev

# Production build
npm run build
npm start
```

### Testing

```bash
# Run tests once
npm run test:run

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test
```

### Database Operations

```bash
# Generate migrations
npm run db:generate

# Run migrations
npm run db:migrate

# Push schema changes
npm run db:push

# Pull schema from database
npm run db:pull

# Drop database
npm run db:drop

# Check migrations
npm run db:check
```

## Testing

The project uses [Vitest](https://vitest.dev/) for testing. Test files should be placed alongside source files with the `.test.ts` extension.

### Current Test Coverage

- `normalizeOrigin` function: Comprehensive tests covering subdomain removal, multi-level TLD handling, URL parsing, edge cases, and error handling.

### Running Specific Tests

```bash
# Run a specific test file
npx vitest src/utils.test.ts

# Run tests matching a pattern
npx vitest --grep "normalizeOrigin"
```
