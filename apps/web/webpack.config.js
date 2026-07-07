const webpack = require("webpack");
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

module.exports = (env, _) => {
    const isProduction = env && env.production ? env.production : false;

    let hostname;
    let protocol;
    if (isProduction) {
        hostname = "code.zxplay.org";
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
    const mainScript = isProduction ? "index.js" : "index.jsx";

    const plugins = [
        new webpack.DefinePlugin({
            STAGING_ENV: JSON.stringify(isProduction ? "prod" : "dev"),
            AUTH_BASE: JSON.stringify(`${protocol}://${hostname}/auth`),
            HOSTNAME: JSON.stringify(hostname),
            HTTP_PROTO: JSON.stringify(protocol),
        }),
        // Emits public/index.html with the content-hashed bundle.js/main.css
        // injected. The template lives outside public/ so it is never
        // overwritten by the emitted file.
        new HtmlWebpackPlugin({
            template: path.join(__dirname, "index.html"),
            filename: "index.html",
            inject: "body",
        }),
        new MiniCssExtractPlugin({
            filename: "dist/[name].[contenthash].css"
        }),
    ];

    const loaders = [
        {
            test: /\.(s?)css$/i,
            use: [
                MiniCssExtractPlugin.loader,
                'css-loader',
                {
                    loader: 'sass-loader',
                    options: {
                        api: 'modern'
                    }
                }
            ],
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
        // Dev: transpile app source on the fly. The shared emulator package
        // resolves (via symlink) to packages/emulator, outside node_modules,
        // so it is transpiled by this rule too.
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
            // Output root is public/ (so index.html lands there and is served
            // at /); JS/CSS carry a dist/ prefix and content hash for immutable
            // caching.
            output: {
                path: path.join(__dirname, "public"),
                filename: "dist/bundle.[contenthash].js",
                assetModuleFilename: "dist/[hash][ext]",
                publicPath: "/"
            },
            entry: path.join(entryPath, mainScript),
            devServer: {
                port: 8000,
                historyApiFallback: true,
                static: {
                    directory: path.join(__dirname, "public")
                },
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
