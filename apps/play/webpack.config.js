const webpack = require("webpack");
const path = require("path");

module.exports = (env, _) => {
    const isProduction = env && env.production ? env.production : false;

    let hostname;
    let protocol;
    if (isProduction) {
        hostname = "zxplay.org";
        protocol = "https";
    } else if (env && env.codespace && env.domain) {
        hostname = `${env.codespace}-8080.${env.domain}`;
        protocol = "https";
    } else {
        hostname = "localhost:8080";
        protocol = "http";
    }

    const srcFolder = path.join(isProduction ? "es5" : "src");
    const entryPath = path.join(__dirname, srcFolder);
    const outputFile = "bundle.js";
    const mainScript = isProduction ? "index.js" : "index.jsx";

    const plugins = [
        new webpack.DefinePlugin({
            STAGING_ENV: JSON.stringify(isProduction ? "prod" : "dev"),
            AUTH_BASE: JSON.stringify(`${protocol}://${hostname}/auth`),
            HOSTNAME: JSON.stringify(hostname),
            HTTP_PROTO: JSON.stringify(protocol),
        }),
    ];

    const loaders = [
        {
            test: /\.(s?)css$/i,
            use: ['style-loader', 'css-loader', 'sass-loader'],
        },
        {
            test: /\.svg/,
            use: 'svg-inline-loader'
        }
    ];

    const babelLoader = {
        loader: "babel-loader",
        options: {
            presets: [
                "@babel/preset-env",
                "@babel/preset-react"
            ],
            plugins: [
                "@babel/plugin-transform-runtime"
            ]
        }
    };

    if (!isProduction) {
        // Dev: transpile app source. The shared emulator package resolves (via
        // symlink) to packages/emulator, outside node_modules, so it is
        // transpiled here too.
        loaders.push({
            test: /\.jsx?$/,
            exclude: /node_modules/,
            use: babelLoader
        });
    } else {
        // Release: app source is pre-transpiled into es5/, but the shared
        // emulator package is consumed from source, so transpile it here.
        loaders.push({
            test: /\.jsx?$/,
            include: /packages[/\\](emulator|i18n|ui)/,
            use: babelLoader
        });
    }

    return [
        {
            mode: isProduction ? "production" : "development",
            devtool: isProduction ? false : "source-map",
            output: {
                path: path.join(__dirname, "public", "dist"),
                filename: outputFile
            },
            entry: path.join(entryPath, mainScript),
            devServer: {
                port: 8001,
                historyApiFallback: true,
                devMiddleware: {
                    writeToDisk: true
                }
            },
            module: {
                rules: loaders
            },
            plugins,
            performance: {hints: false},
            resolve: {
                extensions: ['.js', '.jsx'],
                alias: {
                    fs: false
                }
            }
        }
    ];
}
