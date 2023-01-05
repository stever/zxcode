import React, {useEffect} from "react";
import {useDispatch, useSelector} from "react-redux";
import {Link} from "react-router-dom";
import formatDistance from "date-fns/formatDistance";
import {DataTable} from "primereact/datatable";
import {Column} from "primereact/column";
import {
    subscribeToProjectList,
    unsubscribeFromProjectList
} from "../redux/projectList/actions";

export default function ProjectList() {
    const dispatch = useDispatch();

    const rows = useSelector(state => state?.projectList.projectList);

    useEffect(() => {
        dispatch(subscribeToProjectList());
        return () => {
            dispatch(unsubscribeFromProjectList());
        }
    }, [dispatch]);

    function linkName(data) {
        return (
            <Link to={`/projects/${data['project_id']}`}>
                {data['title']}
            </Link>
        )
    }

    function lang(data) {
        switch (data.lang) {
            case 'asm':
                return 'Pasmo';
            case 'basic':
                return 'zmakebas';
            case 'bas2tap':
                return 'bas2tap';
            case 'c':
                return 'z88dk zcc';
            case 'sdcc':
                return 'SDDC';
            case 'zmac':
                return 'zmac';
            case 'zxbasic':
                return 'Boriel ZX';
            default:
                throw `unexpected case: ${data.lang}`;
        }
    }

    const now = new Date();

    function created(data) {
        const date = new Date(data['created_at']);
        return formatDistance(date, now, {addSuffix: true});
    }

    function updated(data) {
        const date = new Date(data['updated_at']);
        return formatDistance(date, now, {addSuffix: true});
    }

    return (
        <DataTable value={rows}>
            <Column
                field="title"
                header="Project Title"
                body={linkName}
                style={{width: '34%'}}
            />
            <Column
                field="lang"
                header="Compiler"
                body={lang}
                style={{width: '22%'}}
            />
            <Column
                field="created_at"
                header="Created"
                body={created}
                style={{width: '22%'}}
            />
            <Column
                field="updated_at"
                header="Updated"
                body={updated}
                style={{width: '22%'}}
            />
        </DataTable>
    )
}
