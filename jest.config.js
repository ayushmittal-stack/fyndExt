module.exports = {
    verbose: true,
    testEnvironment: 'node',
    roots: ['<rootDir>/test'],
    coverageReporters: ['json-summary', 'lcov'],
    testPathIgnorePatterns: ['/frontend/'],
    modulePathIgnorePatterns: ['<rootDir>/frontend/'],
    setupFiles: ['<rootDir>/jest.init.js'],
    testMatch: [
        '**/test/**/*.spec.[jt]s?(x)',
        '!**/test/global/**/*.[jt]s?(x)'
    ],
    moduleFileExtensions: ['js', 'json'],
    transform: {},
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1'
    },
    coverageDirectory: './coverage',
    collectCoverage: true,
    collectCoverageFrom: [
        '<rootDir>/index.js',
        '<rootDir>/server.js',
        '<rootDir>/src/**/*.js',
    ],
    bail: true
};
