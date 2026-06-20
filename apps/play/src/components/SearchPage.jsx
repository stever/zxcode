import React, {useEffect, useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {DataTable} from "primereact/datatable";
import {Column} from "primereact/column";
import queryString from "query-string";
import axios from "axios";
import {loadUrl} from "../redux/jsspeccy/actions";
import {showLoading, hideLoading} from "../dashboard_loading";
import {sep} from "../constants";

export default function SearchPage() {
    const dispatch = useDispatch();
    const [results, setResults] = useState([]);
    const search = useSelector(state => state?.router.location.search);

    useEffect(() => {
        const parsed = queryString.parse(search);
        const query = parsed.q;

        if (query) {
            const url = (
                'https://archive.org/advancedsearch.php?'
                + encodeParam('q', 'collection:softwarelibrary_zx_spectrum title:"' + query + '"')
                + '&' + encodeParam('fl[]', 'creator')
                + '&' + encodeParam('fl[]', 'identifier')
                + '&' + encodeParam('fl[]', 'title')
                + '&' + encodeParam('rows', '50')
                + '&' + encodeParam('page', '1')
                + '&' + encodeParam('output', 'json')
            );

            showLoading();
            axios.get(url).then((response) => {
                const results = response.data.response.docs;
                setResults(results);
            }).finally(() => {
                hideLoading();
            });
        }

    }, [search]);

    function itemTemplate(rowData) {
        const id = rowData.identifier;
        return (
            <a href="#" onClick={() => {
                const url = `https://archive.org/metadata/${id}`;

                axios.get(url).then((response) => {
                    const files = response.data.files;

                    let chosenFilename = null;

                    files.forEach(file => {
                        const ext = file.name.split('.').pop().toLowerCase();
                        if (ext === 'z80' || ext === 'sna' || ext === 'tap' || ext === 'tzx' || ext === 'szx') {
                            chosenFilename = file.name;
                        }
                    });

                    if (!chosenFilename) {
                        alert('No loadable file found');
                    } else {
                        const openUrl = `https://cors.archive.org/cors/${id}/${chosenFilename}`;
                        dispatch(loadUrl(openUrl));
                    }
                });

            }}>
                {rowData.title}
            </a>
        );
    }

    return (
        <Titled title={(s) => `Search ${sep} ${s}`}>
            <Card className="m-2">
                <h1>Search Results</h1>
                <DataTable value={results} responsiveLayout="scroll">
                    <Column field="title" header="Title" body={itemTemplate}/>
                    <Column field="creator" header="Creator"/>
                </DataTable>
                <p className="mt-5 mb-0">
                    Search powered by <a href="https://archive.org/" target="_blank">
                    Internet Archive
                </a>
                </p>
            </Card>
        </Titled>
    )
}

const encodeParam = (key, val) => {
    return encodeURIComponent(key) + '=' + encodeURIComponent(val);
}
