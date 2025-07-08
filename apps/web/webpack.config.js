const webpack = require("webpack");
const path = require("path");

module.exports = (env, _) => {
    const isProduction = env && env.production ? env.production : false;

    let hostname;
    let protocol;
    if (isProduction) {
        hostname = "zxcoder.org";
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
            use: [
                'style-loader',
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

    if (!isProduction) {
        loaders.push({
            test: /\.jsx?$/,
            exclude: /node_modules/,
            use: {
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
            }
        });
    }

    return [
        {
            name: "worker",
            mode: isProduction ? "production" : "development",
            devtool: isProduction ? false : "source-map",
            output: {
                path: path.join(__dirname, "public", "dist"),
                filename: "jsspeccy-worker.js"
            },
            entry: path.join(__dirname, "src", "lib", "jsspeccy", "worker.js")
        },
        {
            mode: isProduction ? "production" : "development",
            devtool: isProduction ? false : "source-map",
            output: {
                path: path.join(__dirname, "public", "dist"),
                filename: outputFile
            },
            entry: path.join(entryPath, mainScript),
            devServer: {
                port: 8000,
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
