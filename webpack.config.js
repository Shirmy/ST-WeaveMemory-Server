const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = [{
  devtool: false,
  target: 'node',
  entry: './src/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'plugin.js',
    libraryTarget: 'commonjs',
    libraryExport: 'default'
  },
  externals: {
    sqlite3: 'commonjs sqlite3'
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }]
  },
  optimization: {
    minimizer: [new TerserPlugin({ extractComments: false })]
  }
}];
