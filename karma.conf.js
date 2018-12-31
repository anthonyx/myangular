module.exports = function(config) {
  config.set({
    frameworks: ['browserify','jasmine'],
    // Specify which files we are running karma tests on:
    files: [
        'src/**/*.js',
        'test/**/*_spec.js'
    ],
    // Allow you to process files before they are served to the browser
    // We are using minimatch to find the file paths which is why we employ **/*
    preprocessors: {
      'test/**/*.js': ['jshint', 'browserify'],
      'src/**/*.js': ['jshint', 'browserify']
    },
    // We can add Chrome here if we want to run tests through Chrome
    browsers: ['PhantomJS'],
    browserify: {
      debug: true,
      bundleDelay: 2000
    }
  })
}