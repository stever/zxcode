const webpack = require("webpack");
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

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
    const mainScript = isProduction ? "index.js" : "index.jsx";

    const plugins = [
        new webpack.DefinePlugin({
            STAGING_ENV: JSON.stringify(isProduction ? "prod" : "dev"),
            AUTH_BASE: JSON.stringify(`${protocol}://${hostname}/auth`),
            HOSTNAME: JSON.stringify(hostname),
            HTTP_PROTO: JSON.stringify(protocol),
        }),
        // Emits public/index.html with the content-hashed bundle.js injected.
        // The template lives outside public/ so it is never overwritten.
        new HtmlWebpackPlugin({
            template: path.join(__dirname, "index.html"),
            filename: "index.html",
            inject: "body",
        }),
    ];

    const loaders = [
        {
            test: /\.(s?)css$/i,
            use: [
                'style-loader',
                'css-loader',
                {
                    loader: 'sass-loader',
                    options: {
                        // See apps/web's copy: a production build compresses
                        // through dart-sass, which unescapes primeicons'
                        // `content: "\e9b3"` to the literal character and then
                        // prefixes the module with a BOM. style-loader injects
                        // each module as its own <style>, where a leading
                        // U+FEFF is not stripped and kills the rule after it —
                        // primeicons' @font-face, so every icon renders blank.
                        sassOptions: {
                            charset: false
                        }
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
            // Output root is public/ (so index.html lands there and is served
            // at /); the bundle carries a dist/ prefix and content hash for
            // immutable caching.
            output: {
                path: path.join(__dirname, "public"),
                filename: "dist/bundle.[contenthash].js",
                assetModuleFilename: "dist/[hash][ext]",
                publicPath: "/"
            },
            entry: path.join(entryPath, mainScript),
            devServer: {
                port: 8001,
                historyApiFallback: true,
                static: {
                    directory: path.join(__dirname, "public")
                },
                devMiddleware: {
                    writeToDisk: true
                },
                // The official SpecNext distro route, mirroring the Caddy
                // proxy's /specnext/distro/* pass-through: this dev server is
                // reached directly (the dev Caddyfile's catch-all serves the
                // web IDE), so without this the emulator always falls back to
                // the staged /next/ assets in dev.
                proxy: [
                    {
                        context: ["/specnext"],
                        target: "https://www.specnext.com",
                        changeOrigin: true,
                        pathRewrite: {"^/specnext": ""}
                    }
                ]
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
