import path, {sep} from 'path'
import webpack from 'webpack'
import resolve from 'resolve'
import UglifyJSPlugin from 'uglifyjs-webpack-plugin'
import CaseSensitivePathPlugin from 'case-sensitive-paths-webpack-plugin'
import WriteFilePlugin from 'write-file-webpack-plugin'
import FriendlyErrorsWebpackPlugin from 'friendly-errors-webpack-plugin'
import {getPages} from './webpack/utils'
import PagesPlugin from './plugins/pages-plugin'
import SymphonyJsSsrImportPlugin from './plugins/symphonyjs-ssr-import'
import DynamicChunksPlugin from './plugins/dynamic-chunks-plugin'
import UnlinkFilePlugin from './plugins/unlink-file-plugin'
import findBabelConfig from './babel/find-config'
import AppMainEntryPlugin from "./plugins/app-main-entry-plugin";

const symphonyDir = path.join(__dirname, '..', '..', '..')
const symphonyNodeModulesDir = path.join(symphonyDir, 'node_modules')
const symphonyPagesDir = path.join(symphonyDir, 'pages')
const defaultPages = [
  '_error.js',
  '_document.js'
]
const interpolateNames = new Map(defaultPages.map((p) => {
  return [path.join(symphonyPagesDir, p), `dist/bundles/pages/${p}`]
}))

function babelConfig (dir, {isServer, dev}) {
  const mainBabelOptions = {
    cacheDirectory: true,
    presets: [],
    plugins: [
      dev && !isServer && require.resolve('react-hot-loader/babel')
    ].filter(Boolean)
  }

  const externalBabelConfig = findBabelConfig(dir)
  if (externalBabelConfig) {
    // Log it out once
    if (!isServer) {
      console.log(`> Using external babel configuration`)
      console.log(`> Location: "${externalBabelConfig.loc}"`)
    }
    // It's possible to turn off babelrc support via babelrc itself.
    // In that case, we should add our default preset.
    // That's why we need to do this.
    const { options } = externalBabelConfig
    mainBabelOptions.babelrc = options.babelrc !== false
  } else {
    mainBabelOptions.babelrc = false
  }

  // Add our default preset if the no "babelrc" found.
  if (!mainBabelOptions.babelrc) {
    mainBabelOptions.presets.push(require.resolve('./babel/preset'))
  }

  return mainBabelOptions
}

function externalsConfig (dir, isServer) {
  const externals = []

  if (!isServer) {
    return externals
  }

  externals.push((context, request, callback) => {
    resolve(request, { basedir: dir, preserveSymlinks: true }, (err, res) => {
      if (err) {
        return callback()
      }

      // Webpack itself has to be compiled because it doesn't always use module relative paths
      if (res.match(/node_modules[/\\]symphony[/\\]dist[/\\]pages/)) {
        return callback()
      }

      if (res.match(/node_modules[/\\]webpack/)) {
        return callback()
      }

      if (res.match(/node_modules[/\\].*\.js/)) {
        return callback(null, `commonjs ${request}`)
      }

      callback()
    })
  })

  return externals
}

export default async function getBaseWebpackConfig (dir, {dev = false, isServer = false, buildId, config}) {
  const babelLoaderOptions = babelConfig(dir, {dev, isServer})

  const defaultLoaders = {
    babel: {
      loader: 'babel-loader',
      options: babelLoaderOptions
    }
  }

  // Support for NODE_PATH
  const nodePathList = (process.env.NODE_PATH || '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter((p) => !!p)

  let totalPages
  const appEntryFilePath = path.join(dir, config.main)

  let webpackConfig = {
    devtool: dev ? 'source-map' : false,
    name: isServer ? 'server' : 'client',
    cache: true,
    target: isServer ? 'node' : 'web',
    externals: externalsConfig(dir, isServer),
    context: dir,
    entry: async () => {
      const pages = await getPages(dir, {dev, isServer, pageExtensions: config.pageExtensions.join('|')})
      totalPages = Object.keys(pages).length
      const mainJS = require.resolve(`../../client/symphony${dev ? '-dev' : ''}`)
      const clientConfig = !isServer ? {
        'main.js': [
          dev && !isServer && path.join(__dirname, '..', '..', 'client', 'webpack-hot-middleware-client'),
          dev && !isServer && path.join(__dirname, '..', '..', 'client', 'on-demand-entries-client'),
          mainJS,
          appEntryFilePath
        ].filter(Boolean)
      } : {
        'app-main.js': appEntryFilePath
      }
      return {
        ...clientConfig,
        ...pages,
      }
    },
    output: {
      path: path.join(dir, config.distDir, isServer ? 'dist' : ''), // server compilation goes to `.symphony/dist`
      filename: '[name]',
      libraryTarget: 'commonjs2',
      // This saves chunks with the name given via require.ensure()
      chunkFilename: '[name]-[chunkhash].js',
      strictModuleExceptionHandling: true,
      devtoolModuleFilenameTemplate: '[absolute-resource-path]'
    },
    performance: { hints: false },
    resolve: {
      extensions: ['.js', '.jsx', '.json'],
      modules: [
        symphonyNodeModulesDir,
        'node_modules',
        ...nodePathList // Support for NODE_PATH environment variable
      ],
      alias: {
        symphony: symphonyDir,
        // React already does something similar to this.
        // But if the user has react-devtools, it'll throw an error showing that
        // we haven't done dead code elimination (via uglifyjs).
        // We purposly do not uglify React code to save the build time.
        // (But it didn't increase the overall build size)
        // Here we are doing an exact match with '$'
        // So, you can still require nested modules like `react-dom/server`
        react$: dev ? 'react/cjs/react.development.js' : 'react/cjs/react.production.min.js',
        'react-dom$': dev ? 'react-dom/cjs/react-dom.development.js' : 'react-dom/cjs/react-dom.production.min.js'
      }
    },
    resolveLoader: {
      modules: [
        symphonyNodeModulesDir,
        'node_modules',
        path.join(__dirname, 'loaders'),
        ...nodePathList // Support for NODE_PATH environment variable
      ]
    },
    module: {
      rules: [
        dev && !isServer && {
          test: /\.(js|jsx)(\?[^?]*)?$/,
          loader: 'hot-self-accept-loader',
          include: [
            path.join(dir, 'pages'),
            symphonyPagesDir
          ]
        },
        {
          test: /\.+(js|jsx)$/,
          include: [dir],
          exclude: /node_modules/,
          use: defaultLoaders.babel
        }
      ].filter(Boolean)
    },
    plugins: [
      new webpack.IgnorePlugin(/(precomputed)/, /node_modules.+(elliptic)/),
      dev && new webpack.NoEmitOnErrorsPlugin(),
      dev && !isServer && new FriendlyErrorsWebpackPlugin(),
      dev && new webpack.NamedModulesPlugin(),
      dev && !isServer && new webpack.HotModuleReplacementPlugin(), // Hot module replacement
      dev && new UnlinkFilePlugin(),
      dev && new CaseSensitivePathPlugin(), // Since on macOS the filesystem is case-insensitive this will make sure your path are case-sensitive
      dev && new webpack.LoaderOptionsPlugin({
        options: {
          context: dir,
          customInterpolateName (url, name, opts) {
            return interpolateNames.get(this.resourcePath) || url
          }
        }
      }),
      dev && new WriteFilePlugin({
        exitOnErrors: false,
        log: false,
        // required not to cache removed files
        useHashIndex: false
      }),
      !dev && new webpack.IgnorePlugin(/react-hot-loader/),
      !isServer && !dev && new UglifyJSPlugin({
        exclude: /react\.js/,
        parallel: true,
        sourceMap: false,
        uglifyOptions: {
          compress: {
            arrows: false,
            booleans: false,
            collapse_vars: false,
            comparisons: false,
            computed_props: false,
            hoist_funs: false,
            hoist_props: false,
            hoist_vars: false,
            if_return: false,
            inline: false,
            join_vars: false,
            keep_infinity: true,
            loops: false,
            negate_iife: false,
            properties: false,
            reduce_funcs: false,
            reduce_vars: false,
            sequences: false,
            side_effects: false,
            switches: false,
            top_retain: false,
            toplevel: false,
            typeofs: false,
            unused: false,
            conditionals: false,
            dead_code: true,
            evaluate: false
          }
        }
      }),
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production')
      }),
      !isServer && new AppMainEntryPlugin({appEntryFilePath: appEntryFilePath}),
      !dev && new webpack.optimize.ModuleConcatenationPlugin(),
      !isServer && new PagesPlugin(),
      !isServer && new DynamicChunksPlugin(),
      isServer && new SymphonyJsSsrImportPlugin(),
      // In dev mode, we don't move anything to the commons bundle.
      // In production we move common modules into the existing main.js bundle
      !dev && !isServer && new webpack.optimize.CommonsChunkPlugin({
        name: 'main.js',
        filename: 'main.js',
        minChunks (module, count) {
          // react
          if (module.resource && module.resource.includes(`${sep}react-dom${sep}`) && count >= 0) {
            return true
          }

          if (module.resource && module.resource.includes(`${sep}react${sep}`) && count >= 0) {
            return true
          }
          // react end

          // commons
          // If there are one or two pages, only move modules to common if they are
          // used in all of the pages. Otherwise, move modules used in at-least
          // 1/2 of the total pages into commons.
          if (totalPages <= 2) {
            return count >= totalPages
          }
          return count >= totalPages * 0.5
          // commons end
        }
      }),
      // We use a manifest file in development to speed up HMR
      dev && !isServer && new webpack.optimize.CommonsChunkPlugin({
        name: 'manifest',
        filename: 'manifest.js'
      })
    ].filter(Boolean)
  }

  if (typeof config.webpack === 'function') {
    webpackConfig = config.webpack(webpackConfig, {dir, dev, isServer, buildId, config, defaultLoaders, totalPages})
  }

  return webpackConfig
}